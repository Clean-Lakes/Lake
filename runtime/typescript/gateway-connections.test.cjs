const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,mkdir,writeFile,readFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
process.env.LAKE_TS_IMPORT_ONLY='1';
const {startLakeServer}=require('../../bin/lake-runtime/server.cjs');

async function fixture(t){
 const home=await mkdtemp(join(tmpdir(),'lake-channel-http-')),web=join(home,'web');
 await mkdir(web);await writeFile(join(web,'index.html'),'<html>channel transport fixture</html>');
 const app=await startLakeServer({home,data:join(home,'custom data'),port:0,staticRoot:web});
 // These transport/admission tests hold scheduling; the gateway runtime suite
 // separately exercises real Pilot and Worker turns with a model fixture.
 app.superagent.schedule=()=>{};
 t.after(async()=>{await app.close();await rm(home,{recursive:true,force:true});});
 const api=async(path,method='GET',body,expected=200,token=app.token)=>{
  const response=await fetch(app.origin+path,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;
 };
 const project=await api('/api/projects','POST',{name:'channel project'}),other=await api('/api/projects','POST',{name:'other project'});
 const role={id:'channel-role-a',projectId:project.id,roleKey:'a',name:'检查专员',duties:'检查',revision:1,execution:{kind:'native'}};
 const otherRole={...role,id:'channel-role-b',projectId:other.id};
 for(const row of [role,otherRole])app.store.put('superRoles',row.id,row);
 const connect=async(name,routing)=>{
  const connection=await api('/api/settings/gateway/connections','POST',{name,projectId:project.id,...(routing&&{routing})},201);
  const secrets=JSON.parse(await readFile(join(home,'secrets/mcp-gateway.json'),'utf8'));
  return {...connection,token:secrets.tokens.find(row=>row.id===connection.id).token};
 };
 const message=(clientMessageId='client-message-0001',threadId='thread-1')=>({text:'检查服务健康',threadId,clientMessageId});
 return {home,app,api,project,other,role,otherRole,connect,message};
}

test('connection APIs validate project scope, keep credentials private and report only backend readiness',async t=>{
 const f=await fixture(t),connection=await f.connect('我的 Codex');
 const list=await f.api('/api/settings/gateway/connections');
 assert.equal(list.connections.length,1);assert.equal(list.connections[0].projectId,f.project.id);
 assert.equal(JSON.stringify(list).includes(connection.token),false);assert.equal(list.legacyTokens.length,0);
 assert.ok(list.command.data.endsWith('/custom data'));
 assert.deepEqual(list.projects.map(row=>row.id).sort(),[f.project.id,f.other.id].sort());
 await f.api('/api/settings/gateway/connections','POST',{name:'bad project',projectId:'missing'},404);
 await f.api('/api/settings/gateway/connections','POST',{name:'cross-project role',projectId:f.project.id,routing:{mode:'specialist',roleId:f.otherRole.id}},400);
 await f.api(`/api/settings/gateway/connections/${connection.id}`,'PATCH',{projectId:f.other.id},400);
 await f.api(`/api/settings/gateway/connections/${connection.id}`,'PATCH',{routing:{mode:'specialist',roleId:f.otherRole.id}},400);
 const tested=await f.api(`/api/settings/gateway/connections/${connection.id}/test`,'POST',{});
 assert.equal(tested.ready,true);assert.match(tested.message,/外部客户端/);assert.equal(f.app.store.list('superInputs').length,0);
 const client=await f.api('/api/gateway/connection','GET',undefined,200,connection.token);
 assert.equal(client.connection.projectId,f.project.id);assert.equal(client.ready,true);
 const changed=await f.api(`/api/settings/gateway/connections/${connection.id}`,'PATCH',{name:'新名称',expectedUpdatedAt:connection.updatedAt});
 await f.api(`/api/settings/gateway/connections/${connection.id}`,'PATCH',{enabled:false,expectedUpdatedAt:connection.updatedAt},409);
 await f.api(`/api/settings/gateway/connections/${connection.id}`,'PATCH',{enabled:false,expectedUpdatedAt:changed.updatedAt});
 await f.api('/api/gateway/connection','GET',undefined,403,connection.token);
 const disabled=await f.api(`/api/settings/gateway/connections/${connection.id}/test`,'POST',{});
 assert.equal(disabled.ready,false);
 const orphan=await f.connect('原专员连接',{mode:'specialist',roleId:f.role.id});
 f.app.store.put('superRoles',f.role.id,{...f.role,deletedAt:new Date().toISOString()});
 await f.api(`/api/settings/gateway/connections/${orphan.id}`,'PATCH',{enabled:false,name:'已失效连接'});
 await f.api(`/api/settings/gateway/connections/${orphan.id}`,'PATCH',{enabled:true},400);
});

test('transport confines messages and receipts to their connection and keeps legacy endpoints separate',async t=>{
 const f=await fixture(t),a=await f.connect('A'),b=await f.connect('B'),fixed=await f.connect('固定专员',{mode:'specialist',roleId:f.role.id});
 const legacy=await f.api('/api/settings/gateway/tokens','POST',{name:'legacy'},201);
 const first=await f.api('/api/gateway/messages','POST',f.message(),202,a.token);
 const second=await f.api('/api/gateway/messages','POST',f.message(),202,b.token);
 assert.notEqual(first.instructionId,second.instructionId);
 const replay=await f.api('/api/gateway/messages','POST',f.message(),202,a.token);
 assert.equal(replay.instructionId,first.instructionId);assert.equal(replay.duplicate,true);
 await f.api('/api/gateway/messages','POST',{...f.message(),text:'不同内容'},409,a.token);
 await f.api('/api/gateway/messages','POST',{...f.message('client-message-0002'),projectId:f.other.id},400,a.token);
 const scoped=await f.api('/api/gateway/messages','POST',f.message(),202,fixed.token);
 assert.equal(f.app.store.get('superInputs',scoped.eventId).preferredRoleId,f.role.id);
 assert.equal(f.app.store.get('superInputs',first.eventId).preferredRoleId,undefined);
 await f.api(`/api/gateway/messages/${first.instructionId}`,'GET',undefined,404,b.token);
 await f.api(`/api/gateway/messages/${first.instructionId}`,'GET',undefined,403,legacy.token);
 await f.api(`/api/gateway/instructions/${first.instructionId}`,'GET',undefined,403,legacy.token);
 await f.api('/api/gateway/specialists','GET',undefined,403,a.token);
 await f.api(`/api/gateway/specialists/${f.role.id}/instructions`,'POST',{text:'不能绕过连接'},403,a.token);
 await f.api('/api/gateway/messages','POST',f.message(),403,legacy.token);
 await f.api('/api/settings/gateway/connections','GET',undefined,401,a.token);
 const page=await f.api(`/api/settings/gateway/connections/${a.id}/messages`);
 assert.deepEqual(page.messages.map(row=>row.instructionId),[first.instructionId]);
 assert.equal(page.messages[0].connectionId,a.id);
 await f.api(`/api/settings/gateway/connections/${a.id}/messages?limit=51`,'GET',undefined,400);
 await f.api(`/api/settings/gateway/connections/${a.id}`,'DELETE');
 await f.api(`/api/gateway/messages/${first.instructionId}`,'GET',undefined,401,a.token);
 assert.ok(f.app.store.get('superInputs',first.eventId),'deletion revokes ingress but retains source and task history');
});

test('disabling an admitted connection during async preparation prevents durable message creation',async t=>{
 const f=await fixture(t),connection=await f.connect('race');
 let release,entered;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const prepare=f.app.agents.prepareRedaction.bind(f.app.agents);
 f.app.agents.prepareRedaction=async()=>{entered();await gate;return prepare();};
 const send=f.api('/api/gateway/messages','POST',f.message(),403,connection.token);
 await started;
 await f.api(`/api/settings/gateway/connections/${connection.id}`,'PATCH',{enabled:false});
 release();await send;
 assert.equal(f.app.store.list('superInputs').length,0);
 assert.equal(f.app.store.list('superGatewayInstructions').length,0);
});

test('revoking a legacy token during async preparation prevents admission with and without an idempotency key',async t=>{
 const f=await fixture(t),prepare=f.app.agents.prepareRedaction.bind(f.app.agents);
 await f.api('/api/settings/model','PUT',{url:'http://127.0.0.1:1/v1/chat/completions',name:'admission-fixture',apiKey:'synthetic-admission-fixture-key'});
 await f.api(`/api/projects/${f.project.id}/superagent`,'POST',{});
 const instruction=f.app.superagent.gatewayInstruction.bind(f.app.superagent);
 let guardChecks=0;
 f.app.superagent.gatewayInstruction=(roleId,input,guard)=>instruction(roleId,input,()=>{guardChecks++;guard();});
 for(const keyed of [false,true]){
  guardChecks=0;
  const credential=await f.api('/api/settings/gateway/tokens','POST',{name:`legacy-race-${keyed}`},201);
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  f.app.agents.prepareRedaction=async()=>{entered();await gate;return prepare();};
  const sending=f.api(`/api/gateway/specialists/${f.role.id}/instructions`,'POST',{text:'检查服务健康',...(keyed&&{clientRequestId:'legacy-message-0001'})},401,credential.token);
  await started;
  assert.equal(guardChecks,1,'initial authorization succeeds before async preparation');
  await f.api(`/api/settings/gateway/tokens/${credential.id}`,'DELETE');
  release();await sending;
  assert.equal(guardChecks,2,'the transaction guard rechecks the revoked token after async preparation');
  assert.equal(f.app.store.list('superInputs').length,0);
  assert.equal(f.app.store.list('superGatewayInstructions').length,0);
 }
});

test('in-flight long polls revalidate disabled, deleted and changed connections before returning data',async t=>{
 const f=await fixture(t);
 for(const [kind,status] of [['disabled',403],['deleted',401],['changed',409]]){
  const connection=await f.connect(kind),receipt=await f.api('/api/gateway/messages','POST',f.message(),202,connection.token);
  let entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const read=f.app.superagent.gatewayMessageStatus.bind(f.app.superagent);
  f.app.superagent.gatewayMessageStatus=(...args)=>{entered();return read(...args);};
  const polling=f.api(`/api/gateway/messages/${receipt.instructionId}?waitSeconds=5`,'GET',undefined,status,connection.token);
  await started;
  if(kind==='deleted')await f.api(`/api/settings/gateway/connections/${connection.id}`,'DELETE');
  else await f.api(`/api/settings/gateway/connections/${connection.id}`,'PATCH',kind==='disabled'?{enabled:false}:{routing:{mode:'specialist',roleId:f.role.id}});
  await polling;
  f.app.superagent.gatewayMessageStatus=read;
 }
});
