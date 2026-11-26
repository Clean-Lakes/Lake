// Adversarial provider: exercise transport ordering without model inference.
const {createInterface}=require('node:readline');
const {randomUUID}=require('node:crypto');
const scenario=process.env.LAKE_WIRE_SCENARIO;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const pending=new Map();let initialized=false,threadId,turnId;
const note=(method,params)=>send({method,params:{threadId,turnId,...params}});
const ask=(method,params)=>new Promise(resolve=>{const id=randomUUID();pending.set(id,resolve);send({id,method,params});});
async function handle(message){
 if(!message.method){pending.get(message.id)?.(message);pending.delete(message.id);return;}
 const reply=result=>send({id:message.id,result});
 if(message.jsonrpc!==undefined){send({id:message.id,error:{message:'Unexpected JSON-RPC version'}});return;}
 if(message.method==='initialize'){reply({userAgent:'wire-fixture'});return;}
 if(message.method==='initialized'){initialized=true;return;}
 if(message.method==='fixture/slow'){setTimeout(()=>reply('slow'),70);return;}
 if(message.method==='fixture/fast'){reply('fast');return;}
 if(message.method==='fixture/malformed'){process.stdout.write('invalid-json\n');return;}
 if(message.method==='fixture/oversized'){process.stdout.write(' '.repeat(8*1024*1024+1));return;}
 if(message.method==='fixture/descendant'){
  const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  reply(child.pid);return;
 }
 if(message.method==='thread/start'||message.method==='thread/resume'){
  if(!initialized){send({id:message.id,error:{message:'Missing initialized'}});return;}
  threadId=message.params.threadId??'fixture-thread';
  if(message.method==='thread/resume'){
   note('item/agentMessage/delta',{turnId:'historical',itemId:'history',delta:'DO_NOT_REPLAY'});
   note('thread/tokenUsage/updated',{turnId:'historical',tokenUsage:{total:{inputTokens:100,outputTokens:50}}});
  }
  reply({thread:{id:threadId}});return;
 }
 if(message.method==='turn/start'){
  turnId=randomUUID();
  if(scenario!=='early'&&!scenario.startsWith('mcp-'))reply({turn:{id:turnId,status:'inProgress'}});
  if(scenario.startsWith('mcp-')){
   note('item/started',{item:{id:'managed-call',type:'mcpToolCall',server:'lake',tool:'Read',status:'inProgress'}});
   const params={threadId,turnId,serverName:'lake',mode:'form',_meta:{codex_approval_kind:'mcp_tool_call'},requestedSchema:{type:'object',properties:{}}};
   const approval=ask('mcpServer/elicitation/request',params);
   reply({turn:{id:turnId,status:'inProgress'}});
   const answer=await approval;
   if(scenario==='mcp-allowed'&&answer.result?.action!=='accept')throw new Error('Managed transport was not admitted');
   if(scenario==='mcp-unmanaged'&&answer.result?.action!=='cancel')throw new Error('Unmanaged transport was admitted');
   if(scenario==='mcp-revoked'&&!answer.error)throw new Error('Revoked transport was admitted');
   for(const invalid of [params,{...params,threadId:'foreign'},{...params,turnId:'foreign'},{...params,serverName:'foreign'},{...params,_meta:null},{...params,mode:'url'}]){
    const denied=await ask('mcpServer/elicitation/request',invalid);
    if(denied.result?.action!=='cancel')throw new Error('Unmatched or repeated transport permission was admitted');
   }
  }
  if(scenario==='exit'){process.exit(1);return;}
  if(scenario==='hold'||scenario.startsWith('steer-'))return;
  if(scenario==='approval'){
   const params={threadId,turnId,itemId:'native'};
   const command=await ask('item/commandExecution/requestApproval',params);
   const dynamic=await ask('item/tool/call',params);
   if(command.result?.decision!=='decline'||!dynamic.error){process.exit(2);return;}
  }
  if(scenario==='inline-activity'){
   note('item/completed',{item:{id:'a',type:'agentMessage',text:'检查服务'}});
   const read={id:'read',type:'mcpToolCall',server:'lake',tool:'Read',arguments:{file_path:'inspector.yaml'}};
   note('item/started',{item:read});note('item/completed',{item:{...read,status:'completed'}});
   note('item/completed',{item:{id:'b',type:'agentMessage',text:'核对日志'}});
   const cmd={id:'cmd',type:'commandExecution',command:'journalctl -u inspector -n 20'};
   note('item/started',{item:cmd});
   note('item/commandExecution/outputDelta',{itemId:'cmd',delta:'scan '});
   note('item/commandExecution/outputDelta',{itemId:'cmd',delta:'started\n'.replace('\\n','\n')});
   await new Promise(resolve=>setTimeout(resolve,300));
   note('item/completed',{item:{...cmd,status:'completed',exitCode:0,aggregatedOutput:'scan finished'}});
   note('turn/completed',{turn:{id:turnId,status:'completed',items:[]}});return;
  }
  if(scenario==='inline-checklist'){
   const inspect={content:'核对巡检记录',status:'in_progress'},optional={content:'补查历史',status:'pending'};
   const update=(id,todos,status='completed')=>{
    const item={id,type:'mcpToolCall',server:'lake',tool:'TodoWrite'};
    note('item/started',{item:{...item,arguments:{todos}}});
    note('item/completed',{item:{...item,status}});
   };
   update('tasks-added',[inspect,optional]);
   update('tasks-unchanged',[inspect,optional]);
   update('write-failed',[{...inspect,status:'completed'}],'failed');
   note('item/agentMessage/delta',{itemId:'prose',delta:'巡检记录已核对。'});
   update('tasks-finished',[{...inspect,status:'completed'}]);
   update('tasks-added',[inspect,optional]); // Late repeat of the first result.
   note('turn/plan/updated',{threadId:'foreign',plan:[{step:'另一线程',status:'completed'}]});
   note('turn/plan/updated',{plan:[{step:'整理回执',status:'inProgress'}]});
   note('turn/plan/updated',{plan:[{step:'整理回执',status:'completed'}]});
   note('turn/plan/updated',{plan:[{step:'整理回执',status:'completed'}]});
   note('turn/completed',{turn:{id:turnId,status:'completed',items:[]}});return;
  }
  // Foreign output and an old terminal must not become the current report.
  note('item/agentMessage/delta',{threadId:'foreign',itemId:'foreign',delta:'WRONG_THREAD'});
  note('item/agentMessage/delta',{turnId:'old-turn',itemId:'foreign',delta:'WRONG_TURN'});
  note('turn/completed',{turn:{id:'old-turn',status:'failed',items:[]}});
  const first=Buffer.from(JSON.stringify({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'message',delta:'你'}})+'\n');
  const split=first.indexOf(Buffer.from('你'))+1;
  process.stdout.write(first.subarray(0,split));
  await new Promise(resolve=>setImmediate(resolve));
  process.stdout.write(first.subarray(split));
  note('item/agentMessage/delta',{itemId:'message',delta:'好'});
  const tool={id:'tool',type:'mcpToolCall',server:'lake',tool:'Read',status:'inProgress'};
  note('item/started',{item:tool});note('item/completed',{item:{...tool,status:'completed'}});
  const base=message.params.input[0].text==='resumed'?{inputTokens:100,outputTokens:50}:{inputTokens:0,outputTokens:0};
  note('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:base.inputTokens+10,outputTokens:base.outputTokens+5}}});
  const item={id:'message',type:'agentMessage',text:'你好'};
  note('item/completed',{item});
  const finish=()=>{
   note('turn/completed',{turn:{id:turnId,status:'completed',items:[item]}});
   note('turn/completed',{turn:{id:turnId,status:'completed',items:[item]}});
   note('item/agentMessage/delta',{itemId:'message',delta:'LATE_OUTPUT'});
  };
  if(scenario==='early'){finish();reply({turn:{id:turnId,status:'inProgress'}});}
  else setTimeout(finish,40);
  return;
 }
 if(message.method==='turn/steer'){
  if(message.params.threadId!==threadId||message.params.expectedTurnId!==turnId||!message.params.clientUserMessageId||message.params.input?.[0]?.text_elements?.length!==0){process.exit(4);return;}
  if(scenario==='steer-rejected'){send({id:message.id,error:{code:-32600,message:'no active turn'}});return;}
  const item={type:'userMessage',id:randomUUID(),clientId:message.params.clientUserMessageId,content:message.params.input};
  note('item/started',{threadId:'foreign',item});note('item/started',{turnId:'old-turn',item});
  note('item/started',{item:{...item,clientId:'foreign'}});
  note('item/started',{item:{...item,content:[{type:'text',text:'WRONG_CONTENT'}]}});
  if(scenario==='steer-early')note('item/started',{item});
  reply({turnId:scenario==='steer-wrong-ack'?'old-turn':turnId});
  if(scenario==='steer-ack-only'||scenario==='steer-wrong-ack')return;
  setTimeout(()=>{note('item/started',{item});note('item/completed',{item});},20);return;
 }
 if(message.method==='turn/interrupt'){
  if(message.params.threadId!==threadId||message.params.turnId!==turnId){process.exit(3);return;}
  reply({});note('turn/completed',{turn:{id:turnId,status:'interrupted',items:[]}});return;
 }
 send({id:message.id,error:{message:'Unsupported fixture method'}});
}
createInterface({input:process.stdin}).on('line',line=>{void handle(JSON.parse(line));});
