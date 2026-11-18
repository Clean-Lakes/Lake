// App Server fixture for host task, approval and conversation regressions.
// The real pinned provider is separately exercised by acp.integration.test.cjs.
const {createInterface}=require('node:readline');
const {request}=require('node:http');
const {randomUUID}=require('node:crypto');
const mode=process.env.LAKE_TEST_ACP_SCENARIO;
let sessionId,turnId,socket,servers,initialized=false,cancelled=false;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const notify=(method,params)=>send({method,params:{threadId:sessionId,turnId,...params}});
const bridge=(path,input)=>new Promise((resolve,reject)=>{
 const req=request({socketPath:socket,path,method:input?'POST':'GET',headers:{'Content-Type':'application/json'}},res=>{
  const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{try{const body=JSON.parse(Buffer.concat(chunks));res.statusCode===200?resolve(body):reject(new Error(body.error));}catch(error){reject(error);}});
 });req.on('error',reject);req.end(input?JSON.stringify(input):undefined);
});
async function invoke(name,input){
 const item={id:randomUUID(),type:'mcpToolCall',server:'lake',tool:name,status:'inProgress'};
 notify('item/started',{item});
 const result=await bridge('/call',{name,input});
 notify('item/completed',{item:{...item,status:'completed'}});return result.output;
}
async function handle(message){
 if(!message.method)return;
 try{
  if(message.jsonrpc!==undefined)throw new Error('App Server must omit jsonrpc version');
  let result;
  if(message.method==='initialize')result={userAgent:'codex-protocol-fixture',platformFamily:'unix'};
  else if(message.method==='initialized'){initialized=true;return;}
  else if(['thread/start','thread/resume'].includes(message.method)){
   if(!initialized)throw new Error('Missing initialized notification');
   sessionId=message.params.threadId??randomUUID();servers=message.params.config?.mcp_servers??{};
   socket=process.env.LAKE_TEST_ACP_SOCKET??servers.lake?.args.at(-1);result={thread:{id:sessionId}};
  }else if(message.method==='turn/start'){
   turnId=randomUUID();cancelled=false;
   send({id:message.id,result:{turn:{id:turnId,status:'inProgress'}}});
   notify('turn/started',{turn:{id:turnId,status:'inProgress'}});
   let report;
   if(mode==='conversation'){
    if(socket||Object.keys(servers).length)throw new Error('Text-only conversation must not have an MCP transport');
    const input=message.params.input.map(part=>part.text??'').join('\n'),data=JSON.parse(input.slice(input.lastIndexOf('\n')+1));
    report=`${data.self.number}，${data.self.name}通过本人 Codex 会话报到！`;
   }else{
   const tools=await bridge('/tools'),worker=tools.some(tool=>tool.name==='work_finish');let report;
   if(!worker){
    if(mode.includes('prose'))report='我宣称完成了检查，但没有调用任何实际资源工具。';
    else{const writing=mode.includes('write');const output=await invoke(writing?'Write':'Read',{file_path:writing?'child-output.txt':'child-evidence-a.txt',...(writing?{content:'actual child write receipt'}:{})});report='子智能体实际工具回执：'+JSON.stringify(output);}
   }else{
    if(mode.startsWith('super-acp-public-text')){
     const itemId=mode.endsWith('legacy')?'fixture-legacy':'fixture-progress';
     notify('item/agentMessage/delta',{itemId,delta:'先读取项目。'});
     notify('item/agentMessage/delta',{itemId,delta:'继续核对。'});
    }
    if(mode==='super-acp-worker-child')await invoke('Agent',{description:'读取独立任务证据',prompt:'读取 child-evidence-a.txt 并报告实际内容。',subagent_type:'codex-acp',run_in_background:false});
    else await invoke('list_project_files',{path:'.'});
    report='已由独立 ACP Worker 读取实际项目文件。';if(mode!=='super-acp-public-text-unreported')await invoke('work_finish',{summary:report,outcome:'completed'});
    if(mode==='super-acp-public-text-finish-gate'){
     const {existsSync}=require('node:fs'),{setTimeout:delay}=require('node:timers/promises');
     while(!cancelled&&!existsSync(process.env.LAKE_TEST_ACP_RELEASE_FILE))await delay(20);
    }
   }
    if(!cancelled){
     const legacy=mode.endsWith('legacy'),empty=['super-acp-public-text-empty','super-acp-public-text-unreported'].includes(mode);
     finish(empty?'':report,legacy?'fixture-legacy':'fixture-final',legacy?'先读取项目。继续核对。':'');
    }return;
   }
   if(!cancelled)finish(report);return;
  }else if(message.method==='turn/interrupt'){
   cancelled=true;notify('turn/completed',{turn:{id:turnId,status:'interrupted',items:[]}});result={};
  }
  else throw new Error('Unsupported fixture method');
  if(message.id!==undefined)send({id:message.id,result});
 }catch(error){if(message.id!==undefined)send({id:message.id,error:{code:-32603,message:error.message}});}
}
function finish(text,id=randomUUID(),prefix=''){
 const item={id,type:'agentMessage',text:prefix+text};
 notify('item/agentMessage/delta',{itemId:item.id,delta:text});
 notify('item/completed',{item});
 notify('turn/completed',{turn:{id:turnId,status:'completed',items:[item]}});
}
createInterface({input:process.stdin}).on('line',line=>{try{void handle(JSON.parse(line));}catch{}}).on('close',()=>process.exit());
