const test=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {mkdtemp,mkdir,writeFile,readFile,rm,realpath}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
process.env.LAKE_TS_IMPORT_ONLY='1';
const {startLakeServer}=require('../../bin/lake-runtime/server.cjs');

const content=message=>typeof message.content==='string'?message.content:(message.content??[]).map(part=>part.text??'').join('');
async function until(read,predicate){
 const deadline=Date.now()+15000;let value;
 while(Date.now()<deadline){value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,20));}
 assert.fail('Timed out: '+JSON.stringify(value));
}
async function fixture(t,{hold=false,holdRouter=false,routerAction='create',routeParts,holdSecondWorker=false,replyRespond=false,conversation=false,echoResponses=false}={}){
 const releaseRef={release:()=>{}};
 const gatePromise=hold||holdRouter||holdSecondWorker?new Promise(resolve=>{releaseRef.release=resolve;}):Promise.resolve();
 const home=await mkdtemp(join(tmpdir(),'lake-gateway-http-')),web=join(home,'web');
 await mkdir(web);await writeFile(join(web,'index.html'),'<html>gateway fixture</html>');
 const requests=[];
 const provider=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const request=JSON.parse(Buffer.concat(chunks).toString());requests.push(request);
  const tools=request.tools??[],router=tools.some(tool=>tool.function?.name==='route_work'),
    worker=tools.some(tool=>tool.function?.name==='work_finish')&&!router;
  let delta;
  if(router){
   if(holdRouter)await gatePromise;
   const marker=request.messages.findLast(message=>message.role==='user'&&content(message).startsWith('[LAKE ADMITTED HUMAN EVENTS'));
   const event=JSON.parse(content(marker).split('\n')[1])[0];
   const action=replyRespond&&event.replyTo?'respond':routerAction;
   const current=request.messages.slice(Math.max(0,request.messages.indexOf(marker)));
   const names=current.flatMap(message=>message.tool_calls??[]).map(call=>call.function.name);
   if(names.includes('route_work')||names.includes('convene_specialists'))delta={content:action==='ask'?'请补充要检查的数据库名称。':action==='respond'?(echoResponses?`当前回复：${event.text}`:'当前专员负责数据库健康检查。'):'已安排专员检查。'};
   else{
    const parts=routeParts??[{part_key:'external-instruction',action,...(action==='create'?{role_id:event.preferredRoleID??'role-dba',title:'外部指令磁盘检查'}:{}),quote:event.text}];
    delta={tool_calls:conversation?[{index:0,id:'convene-'+event.id,type:'function',function:{name:'convene_specialists',arguments:JSON.stringify({event_id:event.id,part_key:'discussion',quote:event.text,instruction:'请两位分别介绍职责',role_ids:['role-dba','role-sre']})}}]:parts.map((part,index)=>({index,id:'route-'+event.id+'-'+index,type:'function',function:{name:'route_work',arguments:JSON.stringify({event_id:event.id,reason:'外部研发 Agent 指令',...part})}}))};
   }
  }else if(worker){
   const names=request.messages.flatMap(message=>message.tool_calls??[]).map(call=>call.function.name);
   if(hold||holdSecondWorker&&JSON.stringify(request).includes('PUBLISH_CHECK'))await gatePromise;
   delta=names.includes('work_finish')?{content:'本轮检查结束。'}:{tool_calls:[{index:0,id:'finish-1',type:'function',function:{name:'work_finish',arguments:JSON.stringify({summary:'磁盘使用率 42%，无异常日志。',outcome:'completed'})}}]};
  }else delta={content:'收到。'};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write('data: '+JSON.stringify({id:'gateway-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',...delta},finish_reason:null}]})+'\n\n');
  res.write('data: '+JSON.stringify({id:'gateway-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}})+'\n\n');
  res.end('data: [DONE]\n\n');
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const app=await startLakeServer({home,data:join(home,'data'),port:0,staticRoot:web});
 t.after(async()=>{releaseRef.release();await app.close();await new Promise(resolve=>provider.close(resolve));await rm(home,{recursive:true,force:true});});
 const api=async(path,method='GET',body,expected=200,token)=>{
  const response=await fetch(app.origin+path,{method,headers:{Authorization:`Bearer ${token??app.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json().catch(()=>({}));assert.equal(response.status,expected,JSON.stringify(value));return value;
 };
 await api('/api/settings/model','PUT',{url:`http://127.0.0.1:${provider.address().port}/v1/chat/completions`,name:'fixture',apiKey:'synthetic-gateway-key'});
 const project=await api('/api/projects','POST',{name:'isolated gateway'}),pilot=await api(`/api/projects/${project.id}/superagent`,'POST',{});
 const role={id:'role-dba',projectId:project.id,roleKey:'dba',name:'数据库专员',duties:'检查数据库',revision:1,execution:{kind:'native'}},other={...role,id:'role-sre',roleKey:'sre',name:'SRE 专员'};
 for(const entry of [role,other])app.store.put('superRoles',entry.id,entry);
 const scoped=await api('/api/settings/gateway/tokens','POST',{name:'dba-only',roles:[role.id]},201);
 const wide=await api('/api/settings/gateway/tokens','POST',{name:'all-specialists'},201);
 const gw=async(path,method='GET',body,expected=200,which='scoped')=>{
  const bearer=which==='scoped'?scoped.token:which==='wide'?wide.token:which;
  const response=await fetch(app.origin+path,{method,headers:{Authorization:`Bearer ${bearer}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json().catch(()=>({}));if(expected!==null)assert.equal(response.status,expected,JSON.stringify(value));
  return {status:response.status,value};
 };
 const send=async(body,expected=202,which='scoped')=>gw(`/api/gateway/specialists/${role.id}/instructions`,'POST',body,expected,which);
 const status=async(eventId,which='scoped')=>gw(`/api/gateway/instructions/${eventId}?waitSeconds=0`,'GET',undefined,200,which);
 return {home,app,api,gw,send,status,project,pilot,role,other,scoped,wide,requests,release:()=>releaseRef.release()};
}

async function connection(f,name='客户端',routing={mode:'pilot'}){
 const value=await f.api('/api/settings/gateway/connections','POST',{name,projectId:f.project.id,routing},201);
 const secrets=JSON.parse(await readFile(join(f.home,'secrets/mcp-gateway.json'),'utf8'));
 const token=secrets.tokens.find(row=>row.id===value.id).token;
 return {...value,token,
  send:(body,expected=202)=>f.gw('/api/gateway/messages','POST',body,expected,token),
  status:id=>f.gw('/api/gateway/messages/'+id,'GET',undefined,200,token)};
}
const admitted=request=>{
 const marker=request.messages.findLast(message=>message.role==='user'&&content(message).startsWith('[LAKE ADMITTED HUMAN EVENTS'));
 return marker?JSON.parse(content(marker).split('\n')[1]):[];
};

test('connection retries are atomic and client identities and reply targets are scoped by thread',async t=>{
 const f=await fixture(t),a=await connection(f,'A'),b=await connection(f,'B');
 f.app.superagent.schedule=()=>{};
 const input={text:'检查服务',threadId:'thread-a',clientMessageId:'same-client-0001'};
 const receipts=await Promise.all(Array.from({length:8},()=>f.app.superagent.gatewayMessage(a,input)));
 assert.equal(new Set(receipts.map(row=>row.instructionId)).size,1);assert.equal(receipts.filter(row=>row.duplicate).length,7);
 const otherThread=await a.send({...input,threadId:'thread-b'}),otherConnection=await b.send(input);
 assert.equal(new Set([receipts[0].instructionId,otherThread.value.instructionId,otherConnection.value.instructionId]).size,3);
 await a.send({...input,text:'变更的内容'},409);
 await a.send({...input,clientMessageId:'reply-key-0002',threadId:'thread-b',replyTo:receipts[0].instructionId},404);
 await b.send({...input,clientMessageId:'reply-key-0003',replyTo:receipts[0].instructionId},404);
 assert.equal(f.app.store.list('superInputs').filter(row=>row.external?.connectionId).length,3);
 const page=f.app.superagent.gatewayMessages(a.id,{limit:1});
 assert.equal(page.messages.length,1);assert.ok(page.nextCursor);
 const rest=f.app.superagent.gatewayMessages(a.id,{limit:1,cursor:page.nextCursor});
 assert.equal(rest.messages.length,1);assert.notEqual(rest.messages[0].instructionId,page.messages[0].instructionId);
 assert.equal(rest.nextCursor,undefined);
});

test('external Router requests isolate UI, connection and thread history while replyTo retains its actual question',async t=>{
 const f=await fixture(t,{routerAction:'ask',replyRespond:true}),a=await connection(f,'A'),b=await connection(f,'B');
 const router=f.app.store.get('superProjects',f.project.id).routerSessionId;
 await f.app.superagent.send(router,'UI_HISTORY_PRIVATE');
 await until(async()=>f.app.store.list('superInputs'),rows=>rows.some(row=>row.payload==='UI_HISTORY_PRIVATE'&&row.disposition==='routed'));
 const input={text:'A_THREAD_ORIGINAL_DATABASE',threadId:'a-thread',clientMessageId:'ask-client-0001'};
 const first=await a.send(input);
 const asked=await until(()=>a.status(first.value.instructionId),row=>row.value.state==='waiting_input');
 assert.deepEqual(asked.value.replies.map(reply=>reply.text),['请补充要检查的数据库名称。']);
 const other=await b.send({text:'OTHER_CONNECTION_PRIVATE',threadId:'a-thread',clientMessageId:'ask-client-0001'});
 await until(()=>b.status(other.value.instructionId),row=>row.value.state==='waiting_input');
 const otherThread=await a.send({text:'OTHER_THREAD_PRIVATE',threadId:'different-thread',clientMessageId:'ask-client-0001'});
 await until(()=>a.status(otherThread.value.instructionId),row=>row.value.state==='waiting_input');
 const followup=await a.send({...input,text:'就是 accounts 数据库',replyTo:first.value.instructionId,clientMessageId:'reply-client-0002'});
 const result=await until(()=>a.status(followup.value.instructionId),row=>row.value.state==='replied');
 assert.equal(result.value.tasks.length,0);assert.equal(result.value.roleId,undefined);
 const request=f.requests.find(request=>admitted(request).some(event=>event.id===followup.value.eventId));
 const serialized=JSON.stringify(request);
 assert.match(serialized,/A_THREAD_ORIGINAL_DATABASE/);assert.match(serialized,/请补充要检查的数据库名称/);
 for(const forbidden of ['UI_HISTORY_PRIVATE','OTHER_CONNECTION_PRIVATE','OTHER_THREAD_PRIVATE'])assert.equal(serialized.includes(forbidden),false,forbidden);
 for(const request of f.requests.filter(request=>admitted(request).some(event=>event.connectionId)))assert.equal(admitted(request).length,1);
 const source=f.app.store.get('superInputs',followup.value.eventId);
 f.app.superagent.batches.set(router,{eventIds:[source.id],input:'required-current-input'});
 try{assert.throws(()=>f.app.superagent.projectRouterRequest(f.project.id,{messages:[{role:'user',content:'FOREIGN_SDK_HISTORY'}]}),/当前输入缺失/);}
 finally{f.app.superagent.batches.delete(router);}
});

test('project messages collect all exact task reports and do not finish after one worker or an early Pilot acknowledgment',async t=>{
 const f=await fixture(t,{holdSecondWorker:true,routeParts:[
  {part_key:'health',action:'create',role_id:'role-dba',title:'HEALTH_CHECK',quote:'检查服务健康'},
  {part_key:'publish',action:'create',role_id:'role-sre',title:'PUBLISH_CHECK',quote:'核对最近发布'},
  {part_key:'acknowledgment',action:'respond'}]}),a=await connection(f);
 const receipt=await a.send({text:'检查服务健康；核对最近发布',threadId:'two-workers',clientMessageId:'workers-client-0001'});
 const partial=await until(()=>a.status(receipt.value.instructionId),row=>row.value.tasks.length===2&&row.value.replies.filter(reply=>reply.taskId).length===1);
 assert.equal(partial.value.state,'running');
 assert.ok(partial.value.replies.some(reply=>reply.from==='pilot'&&!reply.taskId),'an early Pilot acknowledgment is not task completion');
 assert.ok(partial.value.tasks.every(task=>task.sessionId&&task.roleId&&task.roleName));
 assert.deepEqual(new Set(partial.value.tasks.map(task=>task.roleId)),new Set(['role-dba','role-sre']));
 f.release();
 const done=await until(()=>a.status(receipt.value.instructionId),row=>row.value.state==='replied');
 assert.equal(done.value.replies.filter(reply=>reply.taskId).length,2);
 assert.deepEqual(new Set(done.value.replies.filter(reply=>reply.taskId).map(reply=>reply.taskId)),new Set(done.value.tasks.map(task=>task.taskId)));
 assert.equal(f.app.store.list('superAcceptance').length,0);
 await f.app.close();
 const restarted=await startLakeServer({home:f.home,data:join(f.home,'data'),port:0,staticRoot:join(f.home,'web')});
 t.after(()=>restarted.close());
 const response=await fetch(restarted.origin+'/api/gateway/messages/'+receipt.value.instructionId,{headers:{Authorization:`Bearer ${a.token}`}});
 assert.equal(response.status,200);const restored=await response.json();
 assert.equal(restored.state,'replied');assert.deepEqual(restored.replies,done.value.replies);
});

test('replyTo task controls cannot select another independent task from the same external thread',async t=>{
 const f=await fixture(t),a=await connection(f);
 const base={text:'检查服务',threadId:'one-thread',clientMessageId:'task-client-0001'};
 const first=await a.send(base),firstDone=await until(()=>a.status(first.value.instructionId),row=>row.value.state==='replied');
 const second=await a.send({...base,clientMessageId:'task-client-0002'}),secondDone=await until(()=>a.status(second.value.instructionId),row=>row.value.state==='replied');
 assert.notEqual(firstDone.value.tasks[0].taskId,secondDone.value.tasks[0].taskId,'same thread alone never continues a task');
 f.app.superagent.schedule=()=>{};
 const next=await a.send({...base,text:'继续刚才那个任务',clientMessageId:'task-client-0003',replyTo:first.value.instructionId});
 const event=f.app.store.get('superInputs',next.value.eventId),router=next.value.sessionId;
 assert.doesNotThrow(()=>f.app.superagent.requireGatewayTask(event,firstDone.value.tasks[0].taskId));
 assert.throws(()=>f.app.superagent.requireGatewayTask(event,secondDone.value.tasks[0].taskId),/任务不属于/);
 f.app.superagent.batches.set(router,{eventIds:[event.id],complete:new Set([event.id]),input:'current'});
 try{
  const route=f.app.superagent.routerEntries(router).find(entry=>entry.metadata.name==='route_work');
  await assert.rejects(()=>route.handler({event_id:event.id,part_key:'wrong-task',action:'followup',role_id:'role-dba',task_id:secondDone.value.tasks[0].taskId,quote:event.payload,reason:'继续'},{abortSignal:new AbortController().signal}),/任务不属于/);
 }finally{f.app.superagent.batches.delete(router);}
});

test('fixed-specialist connections route to the bound role and reject other or multiple recipients',async t=>{
 const f=await fixture(t),a=await connection(f,'固定 SRE',{mode:'specialist',roleId:f.other.id});
 const input={text:'检查服务健康',threadId:'fixed-specialist',clientMessageId:'fixed-client-0001'};
 const receipt=await a.send(input);
 assert.equal(receipt.value.roleId,f.other.id);
 assert.equal(f.app.store.get('superInputs',receipt.value.eventId).preferredRoleId,f.other.id);
 const done=await until(()=>a.status(receipt.value.instructionId),row=>row.value.state==='replied');
 assert.equal(done.value.roleId,f.other.id);assert.equal(done.value.tasks.length,1);
 assert.equal(done.value.tasks[0].roleId,f.other.id);assert.equal(done.value.tasks[0].roleName,f.other.name);
 assert.equal(done.value.replies.filter(reply=>reply.taskId).length,1);
 f.app.superagent.schedule=()=>{};
 const next=await a.send({...input,clientMessageId:'fixed-client-0002'});
 const event=f.app.store.get('superInputs',next.value.eventId),router=next.value.sessionId;
 f.app.superagent.batches.set(router,{eventIds:[event.id],complete:new Set([event.id]),input:'current'});
 try{
  const route=f.app.superagent.routerEntries(router).find(entry=>entry.metadata.name==='route_work');
  const create={event_id:event.id,part_key:'fixed-route',action:'create',title:'服务健康',quote:event.payload,reason:'检查'};
  for(const recipients of [{role_id:f.role.id},{role_ids:[f.other.id,f.role.id]}])
   await assert.rejects(()=>route.handler({...create,...recipients},{abortSignal:new AbortController().signal}),/exact source channel role_id/);
  assert.equal(f.app.store.list('superWorkers').length,1,'rejected recipients never create another task');
  assert.equal(f.app.store.list('superDecisions').filter(row=>row.eventId===event.id).length,0);
 }finally{f.app.superagent.batches.delete(router);}
});

test('project messages preserve direct multi-specialist discussion with exact isolated replies and no task creation',async t=>{
 const f=await fixture(t,{conversation:true}),a=await connection(f),router=f.app.store.get('superProjects',f.project.id).routerSessionId;
 f.app.store.addMessage(router,'user','UNRELATED_UI_CONVERSATION');
 f.app.store.addMessage(router,'assistant','UNRELATED_UI_ANSWER');
 const receipt=await a.send({text:'请两位专员各自介绍职责',threadId:'discussion',clientMessageId:'discussion-client-0001'});
 const done=await until(()=>a.status(receipt.value.instructionId),row=>['replied','failed'].includes(row.value.state));
 assert.equal(done.value.state,'replied');assert.equal(done.value.tasks.length,0);
 assert.equal(done.value.conversations.length,1);assert.equal(done.value.conversations[0].members.length,2);
 const replies=done.value.replies.filter(reply=>reply.conversationId);
 assert.equal(replies.filter(reply=>reply.from==='specialist').length,2);
 assert.deepEqual(new Set(replies.filter(reply=>reply.from==='specialist').map(reply=>reply.roleName)),new Set(['数据库专员','SRE 专员']));
 assert.equal(f.app.store.list('superWorkers').length,0);assert.equal(f.app.store.list('superAcceptance').length,0);
 assert.equal(JSON.stringify(f.requests).includes('UNRELATED_UI_CONVERSATION'),false);
 assert.equal(JSON.stringify(f.requests).includes('UNRELATED_UI_ANSWER'),false);
});

test('a scoped gateway token delivers an instruction through Pilot routing and receives the specialist report',async t=>{
 const f=await fixture(t);
 const listed=await f.gw('/api/gateway/specialists','GET',undefined,200,'scoped');
 assert.deepEqual(listed.value.specialists.map(s=>s.roleId),['role-dba'],'a scoped token only sees its allowed specialists');
 const wide=await f.gw('/api/gateway/specialists','GET',undefined,200,'wide');
 assert.equal(wide.value.specialists.length,2);
 const receipt=await f.send({text:'检查生产数据库磁盘使用率',clientRequestId:'instr-0001-abc'});
 assert.equal(receipt.value.roleId,'role-dba');assert.ok(receipt.value.eventId);
 const state=await until(()=>f.status(receipt.value.eventId),state=>['replied','failed','blocked','stopped'].includes(state.value.state));
 assert.equal(state.value.state,'replied');
 assert.equal(state.value.roleName,'数据库专员');
 assert.equal(state.value.tasks.length,1);assert.equal(state.value.tasks[0].goalState,'completed');
 assert.match(state.value.replies[0].text,/磁盘使用率 42%/);assert.equal(state.value.replies[0].from,'specialist');
 assert.ok(state.value.tasks[0].taskId);
 // The instruction message carries the external origin marker for the UI.
 const channel=await f.api(`/api/sessions/${receipt.value.sessionId}/snapshot`);
 assert.ok(channel.messages.some(message=>message.role==='user'&&message.external?.kind==='mcp'));
 const event=f.app.store.get('superInputs',receipt.value.eventId);
 assert.equal(event.external.kind,'mcp');assert.equal(event.preferredRoleId,'role-dba');
 // No business acceptance was minted by the gateway path itself.
 assert.equal(f.app.store.list('superAcceptance').length,0);
});

test('same clientRequestId replays the same instruction; changed content is rejected',async t=>{
 const f=await fixture(t);
 const first=await f.send({text:'检查磁盘',clientRequestId:'instr-uuid-0002'});
 const replay=await f.send({text:'检查磁盘',clientRequestId:'instr-uuid-0002'},202);
 assert.equal(replay.value.instructionId,first.value.instructionId);assert.equal(replay.value.duplicate,true);
 assert.equal(f.app.store.list('superInputs').filter(event=>event.external).length,1,'a replay never creates a second event');
 const changed=await f.send({text:'检查内存',clientRequestId:'instr-uuid-0002'},409);
 assert.match(changed.value.error,/内容已变化/);
 const fresh=await f.send({text:'检查内存',clientRequestId:'instr-uuid-0003'});
 assert.notEqual(fresh.value.eventId,first.value.eventId);
 await until(()=>f.status(fresh.value.eventId),state=>['replied','failed','blocked','stopped'].includes(state.value.state));
});

test('overlapping retries atomically admit one input and reject conflicting content',async t=>{
 const f=await fixture(t);
 f.app.superagent.schedule=()=>{};
 const input={text:'检查磁盘',clientRequestId:'concurrent-retry-0001'};
 const receipts=await Promise.all(Array.from({length:8},()=>f.app.superagent.gatewayInstruction(f.role.id,input)));
 assert.equal(new Set(receipts.map(row=>row.instructionId)).size,1);
 assert.equal(receipts.filter(row=>row.duplicate).length,7);
 assert.equal(f.app.store.list('superInputs').filter(row=>row.external).length,1);
 assert.equal(f.app.store.messages(receipts[0].sessionId).filter(row=>row.external).length,1);
 const conflict=await Promise.allSettled(['检查磁盘','检查内存'].map(text=>f.app.superagent.gatewayInstruction(f.role.id,{text,clientRequestId:'concurrent-conflict-0002'})));
 assert.equal(conflict.filter(row=>row.status==='fulfilled').length,1);
 assert.match(conflict.find(row=>row.status==='rejected').reason.message,/内容已变化/);
});

test('receipt write failure rolls back the input and a retry admits it once',async t=>{
 const f=await fixture(t);
 f.app.superagent.schedule=()=>{};
 const put=f.app.store.put.bind(f.app.store),input={text:'检查磁盘',clientRequestId:'rollback-retry-0001'};
 f.app.store.put=(kind,...args)=>{if(kind==='superGatewayInstructions')throw new Error('synthetic receipt failure');return put(kind,...args);};
 try{await assert.rejects(()=>f.app.superagent.gatewayInstruction(f.role.id,input),/synthetic receipt failure/);}
 finally{f.app.store.put=put;}
 assert.equal(f.app.store.list('superInputs').filter(row=>row.external).length,0);
 assert.equal(f.app.store.list('messages').filter(row=>row.external).length,0);
 const first=await f.app.superagent.gatewayInstruction(f.role.id,input),retry=await f.app.superagent.gatewayInstruction(f.role.id,input);
 assert.equal(retry.instructionId,first.instructionId);assert.equal(retry.duplicate,true);
});

test('a settled Pilot reply belongs only to its admitted instruction and survives restart',async t=>{
 const f=await fixture(t,{holdRouter:true,routerAction:'respond'});
 const receipt=await f.send({text:'解释一下你的职责'});
 const router=f.app.store.get('superProjects',f.project.id).routerSessionId;
 f.app.store.addMessage(router,'assistant','上一条请求刚完成，与当前指令无关。');
 const pending=await f.status(receipt.value.instructionId);
 assert.equal(pending.value.replies.length,0,'a later timestamp does not establish reply ownership');
 f.release();
 const done=await until(()=>f.status(receipt.value.instructionId),row=>row.value.state==='replied');
 assert.equal(done.value.tasks.length,0);
 assert.deepEqual(done.value.replies.map(row=>row.text),['当前专员负责数据库健康检查。']);
 // Read the same receipt through a new backend, after unrelated later prose.
 await until(async()=>f.app.agents.isRunning(router),running=>!running);
 f.app.store.addMessage(router,'assistant','后续另一条请求的回复。');
 await f.app.close();
 const restarted=await startLakeServer({home:f.home,data:join(f.home,'data'),port:0,staticRoot:join(f.home,'web')});
 t.after(()=>restarted.close());
 const response=await fetch(restarted.origin+`/api/gateway/instructions/${receipt.value.instructionId}`,{headers:{Authorization:`Bearer ${f.scoped.token}`}});
 assert.equal(response.status,200);
 const restored=await response.json();
 assert.equal(restored.state,'replied');assert.deepEqual(restored.replies,done.value.replies);
});

test('a Pilot clarification returns waiting_input with its actual question',async t=>{
 const f=await fixture(t,{routerAction:'ask'});
 const receipt=await f.send({text:'检查一下那个数据库'});
 const state=await until(()=>f.status(receipt.value.instructionId),row=>row.value.state==='waiting_input');
 assert.equal(state.value.tasks.length,0);
 assert.deepEqual(state.value.replies.map(row=>row.text),['请补充要检查的数据库名称。']);
});

test('an in-flight long poll observes stopped and blocked events and respects its wait bound',async t=>{
 const f=await fixture(t);
 f.app.superagent.schedule=()=>{};
 for(const disposition of ['stopped','blocked']){
  const receipt=await f.app.superagent.gatewayInstruction(f.role.id,{text:'检查磁盘'});
  const started=Date.now(),waiting=f.app.superagent.instructionStatus(receipt.instructionId,1);
  if(disposition==='stopped')await f.app.superagent.stopChannel(receipt.sessionId);
  else{
   const event=f.app.store.get('superInputs',receipt.eventId);
   f.app.store.put('superInputs',event.id,{...event,disposition,error:'synthetic router failure'});
  }
  const state=await waiting;
  assert.equal(state.disposition,disposition);assert.equal(state.state,disposition==='stopped'?'stopped':'failed');
  if(disposition==='blocked')assert.match(state.error,/synthetic router failure/);
  assert.ok(Date.now()-started<1800,'one-second polling must not sleep for two seconds');
 }
});

test('the MCP command preserves a nondefault backend data directory',async t=>{
 const f=await fixture(t);
 const {command}=await f.api('/api/settings/gateway/tokens');
 assert.equal(command.home,await realpath(f.home));assert.equal(command.data,await realpath(join(f.home,'data')));
});

test('authentication and role scoping reject wrong tokens, session tokens and out-of-scope specialists',async t=>{
 const f=await fixture(t);
 await f.gw('/api/gateway/specialists','GET',undefined,401,'not-a-token');
 await f.gw('/api/gateway/specialists','GET',undefined,401,'');
 const sessionOnGateway=await fetch(f.app.origin+'/api/gateway/specialists',{headers:{Authorization:`Bearer ${f.app.token}`}});
 assert.equal(sessionStatus(sessionOnGateway),401,'the UI session token cannot open the gateway');
 await f.gw(`/api/gateway/specialists/${f.other.id}/instructions`,'POST',{text:'越权'},403,'scoped');
 const wide=await f.gw(`/api/gateway/specialists/${f.other.id}/instructions`,'POST',{text:'允许的指令'},202,'wide');
 assert.ok(wide.value.eventId);
 const gatewayOnApi=await fetch(f.app.origin+'/api/projects',{headers:{Authorization:`Bearer ${f.scoped.token}`}});
 assert.equal(gatewayOnApi.status,401,'the gateway token cannot open the regular API');
 await until(()=>f.status(wide.value.eventId,'wide'),state=>['replied','failed','blocked','stopped'].includes(state.value.state));
 // A revoked token stops working immediately.
 await f.api(`/api/settings/gateway/tokens/${f.scoped.id}`,'DELETE');
 await f.gw('/api/gateway/specialists','GET',undefined,401,'scoped');
 await f.gw(`/api/gateway/specialists/${f.role.id}/instructions`,'POST',{text:'吊销后'},401,'scoped');
});
function sessionStatus(response){return response.status;}

test('stopping the channel marks pending external instructions stopped and late replies cannot arrive',async t=>{
 const f=await fixture(t,{hold:true});
 const receipt=await f.send({text:'检查磁盘'});
 await until(()=>f.status(receipt.value.eventId),state=>state.value.tasks.some(task=>task.activity)||state.value.state==='running');
 // Stop the specialist channel through the UI path while the worker is held.
 await f.api(`/api/sessions/${receipt.value.sessionId}/channel`,'POST',{action:'stop'});
 const state=await f.status(receipt.value.eventId);
 // Lake semantics: routed events keep their disposition; the cancelled task
 // and the signed stop notice express the stop to the external caller.
 assert.equal(state.value.state,'stopped');assert.equal(state.value.disposition,'routed');
 assert.equal(state.value.tasks[0].goalState,'cancelled');
 assert.match(state.value.replies.at(-1).text,/已停止/);
 f.release();
 assert.equal(f.app.store.list('superAcceptance').length,0,'a stopped instruction must not mint acceptance');
});

test('unknown instructions and invalid wait bounds are rejected cleanly',async t=>{
 const f=await fixture(t);
 const missing=await f.gw('/api/gateway/instructions/instr-nope','GET',undefined,null,'wide');
 assert.equal(missing.status,404);
 const badWait=await f.gw('/api/gateway/instructions/instr-nope?waitSeconds=120','GET',undefined,null,'wide');
 assert.equal(badWait.status,400);
 assert.match(badWait.value.error,/waitSeconds/);
});
