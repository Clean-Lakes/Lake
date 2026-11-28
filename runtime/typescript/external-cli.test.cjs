const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,mkdir,readdir,writeFile,rm,stat}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
process.env.LAKE_TS_IMPORT_ONLY='1';
const {startLakeServer}=require('../../bin/lake-runtime/server.cjs');

function cliFixture(agent){
 return `#!${process.execPath}\nconst agent=${JSON.stringify(agent)};\n`+String.raw`
const assert=require('node:assert/strict');
const {existsSync,readFileSync,writeFileSync}=require('node:fs');
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const {join}=require('node:path');
const args=process.argv.slice(2);
if(args.includes('--version')){console.log(agent==='claude-code'?'2.1.332':'1.5.18');process.exit(0);}
const lines=createInterface({input:process.stdin});
const send=frame=>console.log(JSON.stringify(frame));
const response=(id,result)=>send({jsonrpc:'2.0',id,result});
const localClaude=agent==='claude-code'&&!process.env.ANTHROPIC_API_KEY;
assert.equal(process.env.HOME.startsWith(process.cwd()+'/'),!localClaude);
assert.ok(!process.env.LAKE_TEST_PARENT_ENV);
let sequence=0;
async function reportViaBridge(mcp){
 assert.ok(mcp);
 if(mcp.serverUrl){
  assert.equal(new URL(mcp.serverUrl).hostname,'127.0.0.1');
  assert.equal((await fetch(mcp.serverUrl,{method:'POST'})).status,401);
  const rpc=async(method,params)=>{
   const response=await fetch(mcp.serverUrl,{method:'POST',headers:{...mcp.headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params})});
   assert.equal(response.status,200);return (await response.json()).result;
  };
  assert.ok((await rpc('tools/list',{})).tools.some(tool=>tool.name==='work_finish'));
  const result=await rpc('tools/call',{name:'work_finish',arguments:{summary:'ISOLATED_CLI_REPORT',outcome:'completed'}});
  assert.ok(result&&!result.isError);
  return;
 }
 const child=spawn(mcp.command,mcp.args,{stdio:['pipe','pipe','inherit']});
 const stream=createInterface({input:child.stdout})[Symbol.asyncIterator]();
 async function rpc(method,params){
  const id=++sequence;
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  const frame=JSON.parse((await stream.next()).value);
  assert.equal(frame.id,id);assert.ok(frame.result);
  return frame.result;
 }
 try{
  await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'cli-fixture',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools=await rpc('tools/list',{});
  assert.ok(tools.tools.some(tool=>tool.name==='work_finish'));
  const result=await rpc('tools/call',{name:'work_finish',arguments:{summary:'ISOLATED_CLI_REPORT',outcome:'completed'}});
  assert.ok(!result.isError);
 }finally{child.stdin.end();child.kill();}
}

if(agent==='claude-code'){
 assert.ok(args.includes('--restricted')&&args.includes('--strict-mcp-config'));
 assert.equal(args.includes('--bare'),!localClaude);
 if(localClaude){
  const login=JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR,'fixture-login.json'),'utf8'));
  if(args.includes('auth')){
   assert.ok(args.includes('status')&&args.includes('--json'));
   send(login);process.exit(login.loggedIn?0:1);
  }
  if(args.includes('--no-session-persistence')){
   lines.once('line',line=>{
    const request=JSON.parse(line);
    assert.equal(request.type,'control_request');
    assert.equal(request.request.subtype,'initialize');
    send({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models:[
     {value:'default',resolvedModel:'claude-test-model'},{value:'claude-test-model'},{value:'claude-test-alt'},
    ]}}});
   });
   return;
  }
 }
 assert.equal(args[args.indexOf('--tools')+1],'');
 const session_id=args[args.indexOf('--session-id')+1];
 const mcp=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers;
 assert.deepEqual(Object.keys(mcp),['lake']);
 lines.on('line',async line=>{
  assert.equal(JSON.parse(line).session_id,session_id);
  send({type:'system',subtype:'init',session_id,model:'claude-test-model'});
  await reportViaBridge(mcp.lake);
  send({type:'stream_event',session_id,event:{type:'message_start',message:{id:'report'}}});
  for(const text of ['ISOLATED_','CLI_REPORT'])send({type:'stream_event',session_id,event:{type:'content_block_delta',delta:{type:'text_delta',text}}});
  send({type:'result',session_id,subtype:'success',usage:{input_tokens:3,output_tokens:5}});
 });
}else{
 const google=!!process.env.GEMINI_HOME;
 const appData=google?join(process.env.GEMINI_HOME,args[args.indexOf('--app-data-dir')+1]):
  join(process.env.HOME,'.gemini','antigravity-cli');
 const credential=join(appData,'antigravity-oauth-token');
 const settings=JSON.parse(readFileSync(join(appData,'settings.json'),'utf8'));
 assert.ok(settings.permissions.deny.includes('command(*)'));
 if(google){
  assert.ok(!process.env.GEMINI_API_KEY);
  assert.equal(settings.auth.type,'oauth-personal');
  assert.equal(args[args.indexOf('--gemini-dir')+1],process.env.GEMINI_HOME);
  assert.equal(process.env.AGY_ACP_FORCE_FILE_STORAGE,'1');
  if(args.includes('--login')){
   console.log('https://accounts.google.com/o/oauth2/auth?state=fixture-state&response_type=code&code_challenge=fixture&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback');
   lines.once('line',code=>{
    if(!['fixture-code','fixture-empty-models'].includes(code))process.exit(1);
    writeFileSync(credential,code==='fixture-code'?'synthetic-local-google-credential':'empty-catalog',{mode:0o644});
    process.exit(0);
   });
   return;
  }
 }else{
  assert.ok(process.env.GEMINI_API_KEY);
  assert.equal(settings.modelProvider,'gemini');
 }
 assert.deepEqual(args.slice(0,4),['acp','--disable-telemetry','--agent','lake']);
 const config=join(process.env.HOME,'.gemini','config');
 const custom=readFileSync(join(config,'agents','lake.md'),'utf8');
 assert.match(custom,/tools: \[\]/);assert.match(custom,/inheritCustomizations: false/);
 const mcp=JSON.parse(readFileSync(join(config,'mcp_config.json'),'utf8')).mcpServers;
 const sessionId='antigravity-fixture-session';
 const permissionOptions=[{kind:'allow_once',optionId:'allow'},{kind:'reject_once',optionId:'deny'}];
 const responses=new Map();
 function update(data){send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:data}});}
 function ask(toolCall){const id='permission-'+(++sequence);return new Promise(resolve=>{
  responses.set(id,resolve);
  send({jsonrpc:'2.0',method:'session/request_permission',id,params:{sessionId,toolCall,options:permissionOptions}});
 });}
 lines.on('line',async line=>{
  const frame=JSON.parse(line);assert.equal(frame.jsonrpc,'2.0');
  if(responses.has(frame.id)){const resolve=responses.get(frame.id);responses.delete(frame.id);resolve(frame.result.outcome.optionId);return;}
  if(frame.method==='initialize')response(frame.id,{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}}}});
  if(frame.method==='authenticate'){
   assert.equal(frame.params.methodId,'oauth-personal');
   if(existsSync(credential))response(frame.id,{});
   else send({jsonrpc:'2.0',id:frame.id,error:{code:-32000,message:'Authentication required'}});
  }
  if(frame.method==='session/new'){
   const empty=google&&readFileSync(credential,'utf8')==='empty-catalog';
   response(frame.id,{sessionId,configOptions:empty?[]:[{id:'model',type:'select',category:'model',
    currentValue:google?'gemini-google-plan':'gemini-test',options:[{value:google?'gemini-google-plan':'gemini-test'}]}]});
  }
  if(frame.method!=='session/prompt')return;
  assert.deepEqual(Object.keys(mcp),['lake']);
  assert.ok(args.includes('--process-per-session'));
  const tool={sessionUpdate:'tool_call',toolCallId:'fixture-call',name:'call_mcp_tool',status:'pending',rawInput:{ServerName:'lake',ToolName:'work_finish',Arguments:{summary:'ISOLATED_CLI_REPORT',outcome:'completed'}}};
  assert.equal(await ask(tool),'deny','a call without a matching tool event is not admitted');
  assert.equal(await ask({...tool,name:'run_command'}),'deny');
  update(tool);
  assert.equal(await ask({...tool,rawInput:{...tool.rawInput,ServerName:'other'}}),'deny');
  assert.equal(await ask(tool),'allow');
  assert.equal(await ask(tool),'deny','transport approvals can only be used once');
  await reportViaBridge(mcp.lake);
  for(const text of ['ISOLATED_','CLI_REPORT'])update({sessionUpdate:'agent_message_chunk',messageId:'report',content:{type:'text',text}});
  response(frame.id,{stopReason:'end_turn',usage:{inputTokens:3,outputTokens:5}});
 });
}
`;
}

test('CLI profiles bind specialists, dispatch through the private bridge, and publish the actual executor',
 {skip:process.platform!=='darwin',timeout:45000},async t=>{
 const home=await mkdtemp(join(tmpdir(),'lake-external-cli-'));
 const web=join(home,'web');await mkdir(web);await writeFile(join(web,'index.html'),'fixture');
 const app=await startLakeServer({home,data:join(home,'data'),port:0,staticRoot:web});
 t.after(async()=>{await app.close();await rm(home,{recursive:true,force:true});});
 const realFetch=globalThis.fetch;
 const claudeModels=['claude-test-model','claude-test-alt'];
 let catalogReads=0;
 t.mock.method(globalThis,'fetch',async (url,options)=>{
  if(typeof url==='string'&&url.startsWith('https://api.anthropic.com/v1/models?')){
   assert.equal(options.headers['x-api-key'],'synthetic-fixture-claude-code');
   catalogReads++;
   return Response.json({data:[...claudeModels,'invalid id',claudeModels[0]].map(id=>({id}))});
  }
  if(typeof url==='string'&&url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?')){
   assert.equal(options.headers['x-goog-api-key'],'synthetic-fixture-antigravity');
   return Response.json({models:[]});
  }
  return realFetch(url,options);
 });
 process.env.LAKE_TEST_PARENT_ENV='not passed to providers';
 t.after(()=>delete process.env.LAKE_TEST_PARENT_ENV);
 async function request(path,method='GET',body,expected=200){
  const response=await fetch(app.origin+path,{method,headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},
   ...(body&&{body:JSON.stringify(body)})});
  assert.equal(response.status,expected,await response.clone().text());return response.json();
 }
 for(const [agent,kind,model] of [['claude-code','claude-code-cli','claude-test-model'],['antigravity','antigravity-acp','gemini-test']]){
  const project=app.store.createProject(agent+' fixture'),p='/api/projects/'+project.id;
  const channel=app.superagent.createSpecialist(project.id,{name:'Test specialist',duties:'Report a fixture',avatarId:'beaver',requestId:'create-specialist-fixture'});
  const cli=join(home,agent);await writeFile(cli,cliFixture(agent),{mode:0o700});
  const apiKey='synthetic-fixture-'+agent;
  const prepared=await request(p+'/external-agents/'+agent+'/prepare','POST',{expectedRevision:0,enabled:true,executablePath:cli,apiKey});
  assert.deepEqual(prepared.agents.map(row=>row.id),['codex','claude-code','antigravity']);
  assert.ok(!JSON.stringify(prepared).includes(apiKey));
  const status=prepared.agents.find(row=>row.id===agent);
  assert.equal(status.assignmentReady,true,status.assignmentBlocker);
  assert.deepEqual(status.modelOptions,agent==='claude-code'?claudeModels:['gemini-test']);
  if(agent==='claude-code'){
   assert.equal(catalogReads,1);
   const probe=app.agents.external.registry.probe(project.id,agent);
   delete probe.models;app.store.put('acpProbes',project.id+':'+agent,probe);
   const reopened=(await request(p+'/external-agents')).agents.find(row=>row.id===agent);
   assert.deepEqual(reopened.modelOptions,claudeModels);
   assert.equal(reopened.revision,status.revision);
   assert.equal(catalogReads,2);
   await request(p+'/external-agents');
   assert.equal(catalogReads,2,'opening repeatedly reuses the catalog for this configuration');
  }
  const {revision}=await request(p+'/superagent/specialists/'+channel.roleId+'/execution','PUT',{
   expectedRevision:channel.roleRevision,execution:{kind:'acp',agent,revision:status.revision}});
  const receipt=await app.superagent.send(channel.sessionId,'Run the isolated report fixture',undefined,false,undefined,
   {requestId:'external-cli-fixture-request',roleRevision:revision,execution:{kind:'acp',agent,revision:status.revision}});
  let run;
  for(let attempt=0;attempt<250;attempt++){
   run=app.store.list('acpRuns').find(row=>row.workerId===receipt.assignment.workerId);
   if(run&&!['starting','running'].includes(run.state))break;
   await new Promise(resolve=>setTimeout(resolve,35));
  }
  assert.equal(run?.state,'completed',run?.error);
  assert.deepEqual([run.agent,run.runtimeKind,run.model,run.summary],[agent,kind,model,'ISOLATED_CLI_REPORT']);
  assert.deepEqual(run.usage,{inputTokens:3,outputTokens:5});
  assert.equal(run.events.findLast(event=>event.kind==='text').publicText,'ISOLATED_CLI_REPORT');
  const worker=app.store.require('superWorkers',receipt.assignment.workerId);
  assert.equal(worker.roleSnapshot.execution.agent,agent);
  assert.equal(worker.roleSnapshot.execution.revision,status.revision);
  assert.equal(app.store.require('superGoals',worker.taskId).summary,'ISOLATED_CLI_REPORT');
  assert.ok(!JSON.stringify([run,app.store.list('acpProfiles')]).includes(apiKey));
  const secretPath=join(home,'secrets');
  for(const file of await readdir(secretPath)){
   assert.equal((await stat(join(secretPath,file))).mode&0o077,0);
  }
  await request(p+'/external-agents/z-code','PUT',{enabled:true,expectedRevision:0},400);
  const cleared=await request(p+'/external-agents/'+agent+'/prepare','POST',{expectedRevision:status.revision,enabled:true,apiKey:null});
  const disconnected=cleared.agents.find(row=>row.id===agent);
  assert.ok(disconnected.revision>status.revision);assert.equal(disconnected.keyConfigured,false);assert.equal(disconnected.assignmentReady,false);
  assert.equal(disconnected.modelOptions,undefined);
  assert.equal(app.store.require('superWorkers',worker.id).roleSnapshot.execution.revision,status.revision);
 }
});

test('CLI account authentication loads the real catalog shape and preserves the last verified Google login on failure',
 {skip:process.platform!=='darwin',timeout:45000},async t=>{
 const home=await mkdtemp(join(tmpdir(),'lake-external-login-'));
 const web=join(home,'web'),claudeConfig=join(home,'fixture-claude-config');
 await mkdir(web);await mkdir(claudeConfig);await writeFile(join(web,'index.html'),'fixture');
 const previousConfig=process.env.CLAUDE_CONFIG_DIR;
 process.env.CLAUDE_CONFIG_DIR=claudeConfig;
 const app=await startLakeServer({home,data:join(home,'data'),port:0,staticRoot:web});
 t.after(async()=>{
  if(previousConfig===undefined)delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR=previousConfig;
  await app.close();await rm(home,{recursive:true,force:true});
 });
 const project=app.store.createProject('local and browser login');
 const base='/api/projects/'+project.id+'/external-agents';
 async function request(path,method='GET',body,expected=200){
  const response=await fetch(app.origin+base+path,{method,headers:{Authorization:'Bearer '+app.token,
   'Content-Type':'application/json'},...(body&&{body:JSON.stringify(body)})});
  assert.equal(response.status,expected,await response.clone().text());return response.json();
 }
 const claude=join(home,'claude'),agy=join(home,'agy');
 await writeFile(claude,cliFixture('claude-code'),{mode:0o700});await writeFile(agy,cliFixture('antigravity'),{mode:0o700});
 async function dispatch(agent,agentRevision,model){
  const channel=app.superagent.createSpecialist(project.id,{name:agent,duties:'Report a fixture',avatarId:'beaver',requestId:'create-'+agent});
  const execution={kind:'acp',agent,revision:agentRevision};
  const binding=app.superagent.setRoleExecution(project.id,channel.roleId,{expectedRevision:channel.roleRevision,execution});
  const receipt=await app.superagent.send(channel.sessionId,'Run the authenticated fixture',undefined,false,undefined,
   {requestId:'authenticated-fixture-'+agent,roleRevision:binding.revision,execution});
  let run;
  for(let attempt=0;attempt<250;attempt++){
   run=app.store.list('acpRuns').find(row=>row.workerId===receipt.assignment.workerId);
   if(run&&!['starting','running'].includes(run.state))break;
   await new Promise(resolve=>setTimeout(resolve,35));
  }
  assert.equal(run?.state,'completed',run?.error);
  assert.deepEqual([run.agent,run.model,run.summary],[agent,model,'ISOLATED_CLI_REPORT']);
 }
 const accountFile=join(claudeConfig,'fixture-login.json');
 await writeFile(accountFile,JSON.stringify({loggedIn:false,authMethod:'none'}));
 const prepared=await request('/claude-code/prepare','POST',{expectedRevision:0,enabled:true,executablePath:claude});
 const claudeStatus=agents=>agents.find(agent=>agent.id==='claude-code');
 assert.match(claudeStatus(prepared.agents).message,/尚未登录/);
 await writeFile(accountFile,JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'fixture-account@example.invalid'}));
 await request('/claude-code/probe','POST',{});
 const signedIn=claudeStatus((await request('')).agents);
 assert.equal(signedIn.authMode,'claude_login');
 assert.equal(signedIn.assignmentReady,true);
 assert.deepEqual(signedIn.modelOptions,['claude-test-model','claude-test-alt']);
 assert.equal(signedIn.localModel,'claude-test-model');
 await dispatch('claude-code',signedIn.revision,'claude-test-model');
 await writeFile(accountFile,JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'other-fixture@example.invalid'}));
 await request('/claude-code/probe','POST',{});
 assert.equal(claudeStatus((await request('')).agents).revision,signedIn.revision+1);
 assert.ok(!JSON.stringify(app.store.list('acpProbes')).includes('@example.invalid'));

 const {agents}=await request('/antigravity/prepare','POST',{expectedRevision:0,enabled:true,executablePath:agy});
 const googleStatus=agents=>agents.find(agent=>agent.id==='antigravity');
 const initial=googleStatus(agents),loginPath='/antigravity/google-login';
 assert.match(initial.message,/尚未登录/);
 const begin=revision=>request(loginPath,'POST',{expectedRevision:revision});
 const cancelled=await begin(initial.revision);
 await request(loginPath+'/'+cancelled.id,'DELETE');
 await request(loginPath+'/'+cancelled.id,'POST',{code:'fixture-code'},409);
 const login=await begin(initial.revision);
 assert.equal(new URL(login.authorizationUrl).origin,'https://accounts.google.com');
 await request(loginPath+'/'+login.id,'POST',{code:'https://antigravity.google/oauth-callback?state=other&code=fixture-code'},400);
 const completed=await request(loginPath+'/'+login.id,'POST',{code:'fixture-code'});
 const google=googleStatus(completed.agents);
 assert.equal(google.authMode,'google');
 assert.equal(google.assignmentReady,true);
 assert.deepEqual(google.modelOptions,['gemini-google-plan']);
 assert.equal(google.revision,initial.revision+1);
 assert.ok(!JSON.stringify(completed).includes(login.id));
 await dispatch('antigravity',google.revision,'gemini-google-plan');
 const credentials=join(home,'secrets','antigravity',project.id,login.id);
 assert.equal((await stat(join(credentials,'antigravity-oauth-token'))).mode&0o077,0);
 const retry=await begin(google.revision);
 await request(loginPath+'/'+retry.id,'POST',{code:'fixture-empty-models'},409);
 const current=googleStatus((await request('')).agents);
 assert.equal(current.revision,google.revision);
 assert.deepEqual(current.modelOptions,google.modelOptions);
 assert.deepEqual(await readdir(join(home,'secrets','antigravity',project.id)),[login.id]);
 await request('/antigravity/probe','POST',{});
 assert.equal(googleStatus((await request('')).agents).assignmentReady,true);
});
