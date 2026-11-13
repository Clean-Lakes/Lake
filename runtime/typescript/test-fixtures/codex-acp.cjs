// Deterministic ACP protocol fixture for host lifecycle/permission regressions.
// Real pinned Codex is separately exercised by acp.integration.test.cjs.
const {createInterface}=require('node:readline');
const {request}=require('node:http');
const {randomUUID}=require('node:crypto');
const mode=process.env.LAKE_TEST_ACP_SCENARIO;
let sessionId,socket,servers,sequence=0;const pending=new Map();
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const notify=update=>send({method:'session/update',params:{sessionId,update}});
const ask=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});send({id,method,params});});
const bridge=(path,input)=>new Promise((resolve,reject)=>{
 const req=request({socketPath:socket,path,method:input?'POST':'GET',headers:{'Content-Type':'application/json'}},res=>{
  const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{try{const body=JSON.parse(Buffer.concat(chunks));res.statusCode===200?resolve(body):reject(new Error(body.error));}catch(error){reject(error);}});
 });req.on('error',reject);req.end(input?JSON.stringify(input):undefined);
});
async function invoke(name,input){
 const toolCallId=randomUUID(),toolCall={toolCallId,title:name,kind:'other',status:'pending',rawInput:{server:'lake',tool:name}};
 notify({sessionUpdate:'tool_call',...toolCall});
 const permission=await ask('session/request_permission',{sessionId,toolCall,options:[{optionId:'once',name:'Allow once',kind:'allow_once'}],_meta:{is_mcp_tool_approval:true}});
 if(permission.outcome?.outcome!=='selected')throw new Error('Transport entry rejected');
 const result=await bridge('/call',{name,input});
 notify({sessionUpdate:'tool_call_update',toolCallId,status:'completed'});return result.output;
}
async function handle(message){
 if(!message.method){const waiter=pending.get(message.id);if(waiter){pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message.result);}return;}
 try{
  let result;
  if(message.method==='initialize')result={protocolVersion:1,agentInfo:{name:'codex-protocol-fixture',version:'1'},agentCapabilities:{loadSession:true}};
  else if(['session/new','session/load'].includes(message.method)){
   sessionId=message.params.sessionId??randomUUID();servers=message.params.mcpServers;socket=process.env.LAKE_TEST_ACP_SOCKET??servers[0]?.args.at(-1);result=message.method==='session/new'?{sessionId}:{};
  }else if(message.method==='session/prompt'&&mode==='conversation'){
   if(socket||servers.length)throw new Error('Text-only conversation must not have an MCP transport');
   const input=message.params.prompt.map(part=>part.text??'').join('\n'),data=JSON.parse(input.slice(input.lastIndexOf('\n')+1));
   notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:`${data.self.number}，${data.self.name}通过本人 ACP 会话报到！`}});result={stopReason:'end_turn'};
  }else if(message.method==='session/prompt'){
   const tools=await bridge('/tools'),worker=tools.some(tool=>tool.name==='work_finish');let report;
   if(!worker){
    if(mode.includes('prose'))report='我宣称完成了检查，但没有调用任何实际资源工具。';
    else{const writing=mode.includes('write');const output=await invoke(writing?'Write':'Read',{file_path:writing?'child-output.txt':'child-evidence-a.txt',...(writing?{content:'actual child write receipt'}:{})});report='子智能体实际工具回执：'+JSON.stringify(output);}
   }else{
    if(mode==='super-acp-worker-child')await invoke('Agent',{description:'读取独立任务证据',prompt:'读取 child-evidence-a.txt 并报告实际内容。',subagent_type:'codex-acp',run_in_background:false});
    else await invoke('list_project_files',{path:'.'});
    report='已由独立 ACP Worker 读取实际项目文件。';await invoke('work_finish',{summary:report,outcome:'completed'});
   }
   notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:report}});result={stopReason:'end_turn'};
  }else if(message.method==='session/cancel')return;
  else throw new Error('Unsupported fixture method');
  if(message.id!==undefined)send({id:message.id,result});
 }catch(error){if(message.id!==undefined)send({id:message.id,error:{code:-32603,message:error.message}});}
}
createInterface({input:process.stdin}).on('line',line=>{try{void handle(JSON.parse(line));}catch{}}).on('close',()=>process.exit());
