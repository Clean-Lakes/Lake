const test=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {mkdtemp,mkdir,writeFile,rm}=require('node:fs/promises');
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
async function fixture(t,{hold=false}={}){
 const releaseRef={release:()=>{}};
 const gatePromise=hold?new Promise(resolve=>{releaseRef.release=resolve;}):Promise.resolve();
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
   const marker=request.messages.findLast(message=>message.role==='user'&&content(message).startsWith('[LAKE ADMITTED HUMAN EVENTS'));
   const current=request.messages.slice(Math.max(0,request.messages.indexOf(marker)));
   const names=current.flatMap(message=>message.tool_calls??[]).map(call=>call.function.name);
   if(names.includes('route_work'))delta={content:'已安排专员检查。'};
   else{
    const event=JSON.parse(content(marker).split('\n')[1])[0];
    delta={tool_calls:[{index:0,id:'route-'+event.id,type:'function',function:{name:'route_work',arguments:JSON.stringify({event_id:event.id,part_key:'external-instruction',action:'create',role_id:event.preferredRoleID??'role-dba',quote:event.text,title:'外部指令磁盘检查',reason:'外部研发 Agent 指令'})}}]};
   }
  }else if(worker){
   const names=request.messages.flatMap(message=>message.tool_calls??[]).map(call=>call.function.name);
   await gatePromise;
   delta=names.includes('work_finish')?{content:'本轮检查结束。'}:{tool_calls:[{index:0,id:'finish-1',type:'function',function:{name:'work_finish',arguments:JSON.stringify({summary:'磁盘使用率 42%，无异常日志。',outcome:'completed'})}}]};
  }else delta={content:'收到。'};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write('data: '+JSON.stringify({id:'gateway-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',...delta},finish_reason:null}]})+'\n\n');
  res.write('data: '+JSON.stringify({id:'gateway-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}})+'\n\n');
  res.end('data: [DONE]\n\n');
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const app=await startLakeServer({home,data:join(home,'data'),port:0,staticRoot:web});
 t.after(async()=>{await app.close();await new Promise(resolve=>provider.close(resolve));await rm(home,{recursive:true,force:true});});
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
 return {app,api,gw,send,status,project,pilot,role,other,scoped,wide,requests,release:()=>releaseRef.release()};
}

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
