const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {mkdtemp,mkdir,readdir,writeFile,rm,stat}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
process.env.LAKE_TS_IMPORT_ONLY='1';
const {startLakeServer}=require('../../bin/lake-runtime/server.cjs');

const openingUpdate='我会先核对样例目录，再比较两份记录。';
function cliFixture(agent,progress=false){
 return `#!${process.execPath}\nconst agent=${JSON.stringify(agent)};\nconst progress=${progress};\nconst openingUpdate=${JSON.stringify(openingUpdate)};\n`+String.raw`
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
const localClaude=agent==='claude-code'&&!process.env.ANTHROPIC_API_KEY&&!process.env.ANTHROPIC_AUTH_TOKEN;
assert.equal(process.env.HOME.startsWith(process.cwd()+'/'),!localClaude);
assert.ok(!process.env.LAKE_TEST_PARENT_ENV);
let sequence=0;
async function submitReport(rpc){
 const tools=(await rpc('tools/list',{})).tools;
 for(const name of ['TodoWrite','work_finish'])assert.ok(tools.some(tool=>tool.name===name),name);
 const writeTodos=todos=>rpc('tools/call',{name:'TodoWrite',arguments:{todos}});
 const first={content:'查看样例目录',status:'pending',priority:'high'};
 const second={content:'核对样例记录',status:'pending',priority:'medium'};
 const running={...first,status:'in_progress'};
 assert.ok(!(await writeTodos([first,second])).isError);
 assert.ok((await writeTodos([{...first,content:'x'.repeat(100001),status:'completed'}])).isError);
 assert.ok(!(await writeTodos([running,second])).isError);
 assert.ok(!(await writeTodos([running,second])).isError);
 assert.ok(!(await rpc('tools/call',{name:'list_assets',arguments:{query:'isolated-fixture'}})).isError);
 assert.ok(!(await writeTodos([{...first,status:'completed'},second])).isError);
 const result=await rpc('tools/call',{name:'work_finish',arguments:{summary:'ISOLATED_CLI_REPORT',outcome:'completed'}});
 assert.ok(result&&!result.isError);
}
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
  await submitReport(rpc);
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
  await submitReport(rpc);
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
     {value:'default',resolvedModel:'claude-test-model',supportsEffort:true,supportedEffortLevels:['low','high']},
     {value:'claude-test-model',supportsEffort:true,supportedEffortLevels:['low','high']},
     {value:'claude-test-alt',supportsEffort:true,supportedEffortLevels:['medium','max']},
    ]}}});
   });
   return;
  }
 }
 if(localClaude)assert.equal(args[args.indexOf('--effort')+1],'high');
 assert.equal(args[args.indexOf('--tools')+1],'');
 const session_id=args[args.indexOf('--session-id')+1];
 const mcp=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers;
 assert.deepEqual(Object.keys(mcp),['lake']);
 const gateway=process.env.ANTHROPIC_BASE_URL;
 const model=gateway?args[args.indexOf('--model')+1]:'claude-test-model';
 lines.on('line',async line=>{
  assert.equal(JSON.parse(line).session_id,session_id);
  if(gateway){
   const key=process.env.ANTHROPIC_API_KEY,token=process.env.ANTHROPIC_AUTH_TOKEN;
   assert.notEqual(!!key,!!token);
   const headers={'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{'x-api-key':key})};
   const result=await fetch(gateway+'/v1/messages',{method:'POST',headers,body:JSON.stringify({model,max_tokens:2})});
   assert.ok(result.ok);
   await result.body.cancel();
  }
  send({type:'system',subtype:'init',session_id,model});
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
 assert.equal(custom.includes('"ServerName":"lake","ToolName":"TodoWrite","Arguments":'),!!mcp.lake);
 const sessionId='antigravity-fixture-session';
 const modelIds=google?['gemini-google-plan','gemini-google-pro']:['gemini-test'];
 let modelId=modelIds[0],effort='low';
 function effortOptions(){return modelId==='gemini-google-pro'?['medium','extra']:['low','high'];}
 function configOptions(){
  const model={id:'model',type:'select',category:'model',currentValue:modelId,options:modelIds.map(value=>({value}))};
  return google?[model,{id:'thinking_level',type:'select',category:'thought_level',currentValue:effort,
   options:[{group:'levels',options:effortOptions().map(value=>({value}))}]}]:[model];
 }
 const permissionOptions=[{kind:'allow_once',optionId:'allow'},{kind:'reject_once',optionId:'deny'}];
 const responses=new Map();
 function update(data,target=sessionId){send({jsonrpc:'2.0',method:'session/update',params:{sessionId:target,update:data}});}
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
   response(frame.id,{sessionId,configOptions:empty?[]:configOptions()});
  }
  if(frame.method==='session/set_config_option'){
   const {configId,value}=frame.params;
   assert.equal(frame.params.sessionId,sessionId);
   if(configId==='model'){assert.ok(modelIds.includes(value));modelId=value;effort=effortOptions()[0];}
   else {assert.equal(configId,'thinking_level');assert.ok(effortOptions().includes(value));effort=value;}
   response(frame.id,{configOptions:configOptions()});
  }
  if(frame.method!=='session/prompt')return;
  if(google)assert.deepEqual([modelId,effort],['gemini-google-pro','extra']);
  assert.deepEqual(Object.keys(mcp),['lake']);
  assert.ok(args.includes('--process-per-session'));
  if(progress){
   const entry={content:'核查发布样例',priority:'medium',status:'pending'};
   const plan={sessionUpdate:'plan',entries:[entry]};
   update({...plan,entries:[{...entry,content:'外部会话的计划'}]},'foreign-session');
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:openingUpdate}});
   update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'PRIVATE_FIXTURE_THOUGHT'}});
   update(plan);
   update(plan);
   update({...plan,entries:[{...entry,status:'in_progress'}]});
   update({...plan,entries:[{...entry,status:'invalid'}]});
   update({...plan,entries:[{...entry,status:'completed'}]});
  }
  const tool={sessionUpdate:'tool_call',toolCallId:'fixture-call',name:'call_mcp_tool',status:'pending',rawInput:{ServerName:'lake',ToolName:'work_finish',Arguments:{summary:'ISOLATED_CLI_REPORT',outcome:'completed'}}};
  assert.equal(await ask(tool),'deny','a call without a matching tool event is not admitted');
  assert.equal(await ask({...tool,name:'run_command'}),'deny');
  update(tool);
  assert.equal(await ask({...tool,rawInput:{...tool.rawInput,ServerName:'other'}}),'deny');
  assert.equal(await ask(tool),'allow');
  assert.equal(await ask(tool),'deny','transport approvals can only be used once');
  await reportViaBridge(mcp.lake);
  for(const text of [progress?'\n\nISOLATED_':'ISOLATED_','CLI_REPORT'])update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
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
   return Response.json({data:[...claudeModels,'invalid id',claudeModels[0]].map(id=>({id,capabilities:{effort:{
    supported:true,low:{supported:true},high:{supported:true},max:{supported:false},
   }}}))});
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
  const agy=agent==='antigravity';
  const cli=join(home,agent);await writeFile(cli,cliFixture(agent,agy),{mode:0o700});
  const apiKey='synthetic-fixture-'+agent;
  const prepared=await request(p+'/external-agents/'+agent+'/prepare','POST',{expectedRevision:0,enabled:true,executablePath:cli,apiKey});
  assert.deepEqual(prepared.agents.map(row=>row.id),['codex','claude-code','antigravity']);
  assert.ok(!JSON.stringify(prepared).includes(apiKey));
  const status=prepared.agents.find(row=>row.id===agent);
  assert.equal(status.assignmentReady,true,status.assignmentBlocker);
  assert.deepEqual(status.modelOptions,agent==='claude-code'?claudeModels:['gemini-test']);
  if(agent==='claude-code'){
   assert.deepEqual(status.modelEffortOptions[claudeModels[0]],['low','high']);
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
  assert.deepEqual([run.agent,run.runtimeKind,run.model],[agent,kind,model]);
  assert.equal(run.summary,agy?openingUpdate+'\n\nISOLATED_CLI_REPORT':'ISOLATED_CLI_REPORT');
  assert.deepEqual(run.usage,{inputTokens:3,outputTokens:5});
  const proseEvents=run.events.filter(event=>event.kind==='text');
  assert.equal(proseEvents.at(-1).publicText,run.summary);
  const worker=app.store.require('superWorkers',receipt.assignment.workerId);
  const toolSteps=run.events.filter(event=>event.title==='list_assets');
  assert.deepEqual(toolSteps.map(event=>[event.kind,event.status,event.toolSource]),[
   ['tool','running','lake-bridge'],['tool_update','completed','lake-bridge'],
  ]);
  assert.equal(toolSteps[0].callId,toolSteps[1].callId);
  const changes=[
   ['查看样例目录','pending',true],['核对样例记录','pending',true],
   ['查看样例目录','in_progress',false],['查看样例目录','completed',false],
  ];
  const todoEvents=run.events.filter(event=>event.title==='TodoWrite'&&event.displayKind==='task');
  assert.deepEqual(todoEvents.filter(event=>event.taskState).map(event=>[event.detail,event.taskState,!!event.createdTask]),changes);
  assert.deepEqual(todoEvents.filter(event=>!event.taskState).map(event=>event.status),['failed']);
  assert.ok(todoEvents.every(event=>event.toolSource==='lake-bridge'));
  assert.equal(new Set(todoEvents.map(event=>event.callId)).size,todoEvents.length);
  const liveProcess=app.store.view(worker.sessionId).cards.find(card=>card.id===run.id)?.data.codex_activity;
  assert.equal(liveProcess?.filter(item=>item.text==='list_assets'&&item.status==='completed').length,1);
  const checklist=items=>items?.filter(item=>item.kind==='task'&&item.taskState).map(item=>[item.text,item.taskState,!!item.createdTask]);
  const planChanges=agy?[
   ['核查发布样例','pending',true],['核查发布样例','in_progress',false],['核查发布样例','completed',false],
  ]:[];
  assert.deepEqual(checklist(liveProcess),[...planChanges,...changes]);
  if(agy){
   assert.equal(new Set(proseEvents.map(event=>event.publicTextId)).size,1);
   assert.equal(liveProcess[0].text,openingUpdate);
   assert.deepEqual(liveProcess.filter(item=>item.kind==='text').map(item=>item.text),[openingUpdate]);
   assert.ok(!JSON.stringify(run).includes('PRIVATE_FIXTURE_THOUGHT'));
   assert.deepEqual(run.events.filter(event=>event.toolSource==='agent-plan').map(event=>[event.detail,event.taskState,!!event.createdTask]),planChanges);
  }
  let report;
  for(let attempt=0;attempt<150&&!report;attempt++){
   report=app.store.list('messages').find(message=>message.sessionId===channel.sessionId&&message.author?.workerId===worker.id&&message.id.startsWith('report_'));
   if(!report)await new Promise(resolve=>setTimeout(resolve,35));
  }
  assert.ok(report?.codexActivity?.some(item=>item.text==='list_assets'&&item.status==='completed'),'delivered report keeps the process');
  assert.deepEqual(checklist(report.codexActivity),[...planChanges,...changes]);
  if(agy){
   assert.equal(report.text,'ISOLATED_CLI_REPORT');
   assert.deepEqual(report.codexActivity.filter(item=>item.kind==='text').map(item=>item.text),[openingUpdate]);
   const oldActivity=report.codexActivity.map(item=>item.kind==='text'?{...item,text:run.summary}:item);
   app.store.put('messages',report.id,{...report,codexActivity:oldActivity});
   const historyWithDuplicate=await request('/api/sessions/'+channel.sessionId+'/channel');
   const repaired=historyWithDuplicate.entries.find(entry=>entry.message?.id===report.id)?.message;
   assert.equal(repaired?.text,report.text);
   assert.deepEqual(repaired?.codexActivity,report.codexActivity);
   assert.deepEqual(app.store.require('messages',report.id).codexActivity,oldActivity);

   const {codexActivity,...oldReport}=report;
   app.store.put('messages',oldReport.id,oldReport);
   const view=app.store.view(worker.sessionId),card=view.cards.find(card=>card.id===run.id);
   delete card.data.codex_activity;
   card.data.external_events=[
    {kind:'tool',callId:'saved-call',title:'读取历史样例',status:'in_progress',at:toolSteps[0].at},
    {kind:'tool_update',callId:'saved-call',status:'completed',at:toolSteps[1].at},
   ];
   app.store.put('views',worker.sessionId,view);
   const history=await request('/api/sessions/'+channel.sessionId+'/channel');
   const restored=history.entries.find(entry=>entry.message?.id===oldReport.id)?.message;
   assert.deepEqual(restored?.codexActivity?.map(item=>[item.text,item.status]),[['读取历史样例','completed']]);
   assert.equal(app.store.require('messages',oldReport.id).codexActivity,undefined);
  }
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
 async function dispatch(agent,agentRevision,model,effort){
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
  assert.deepEqual([run.agent,run.model,run.reasoningEffort,run.summary],[agent,model,effort,'ISOLATED_CLI_REPORT']);
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
 assert.deepEqual(signedIn.reasoningEffortOptions,['low','high']);
 await request('/claude-code/prepare','POST',{expectedRevision:signedIn.revision,enabled:true,reasoningEffortOverride:'max'},400);
 const claudeConfigured=claudeStatus((await request('/claude-code/prepare','POST',{
  expectedRevision:signedIn.revision,enabled:true,reasoningEffortOverride:'high',
 })).agents);
 await dispatch('claude-code',claudeConfigured.revision,'claude-test-model','high');
 await writeFile(accountFile,JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'other-fixture@example.invalid'}));
 await request('/claude-code/probe','POST',{});
 assert.equal(claudeStatus((await request('')).agents).revision,claudeConfigured.revision+1);
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
 assert.deepEqual(google.modelOptions,['gemini-google-plan','gemini-google-pro']);
 assert.deepEqual(google.modelEffortOptions,{'gemini-google-plan':['low','high'],'gemini-google-pro':['medium','extra']});
 assert.equal(google.reasoningEffort,'low','catalog probing keeps the initial model and default effort');
 assert.equal(google.revision,initial.revision+1);
 assert.ok(!JSON.stringify(completed).includes(login.id));
 const stored=app.agents.external.registry.probe(project.id,'antigravity');
 delete stored.cliCatalogVersion;delete stored.models[0].reasoningEfforts;
 app.store.put('acpProbes',project.id+':antigravity',stored);
 assert.deepEqual(googleStatus((await request('')).agents).modelEffortOptions,google.modelEffortOptions);
 await request('/antigravity/prepare','POST',{expectedRevision:google.revision,enabled:true,
  modelOverride:'gemini-google-pro',reasoningEffortOverride:'high'},400);
 const googleConfigured=googleStatus((await request('/antigravity/prepare','POST',{expectedRevision:google.revision,enabled:true,
  modelOverride:'gemini-google-pro',reasoningEffortOverride:'extra'})).agents);
 await dispatch('antigravity',googleConfigured.revision,'gemini-google-pro','extra');
 const credentials=join(home,'secrets','antigravity',project.id,login.id);
 assert.equal((await stat(join(credentials,'antigravity-oauth-token'))).mode&0o077,0);
 const retry=await begin(googleConfigured.revision);
 await request(loginPath+'/'+retry.id,'POST',{code:'fixture-empty-models'},409);
 const current=googleStatus((await request('')).agents);
 assert.equal(current.revision,googleConfigured.revision);
 assert.deepEqual(current.modelOptions,google.modelOptions);
 assert.deepEqual(await readdir(join(home,'secrets','antigravity',project.id)),[login.id]);
 await request('/antigravity/probe','POST',{});
 assert.equal(googleStatus((await request('')).agents).assignmentReady,true);
});

test('Claude custom API loads third-party models and isolates gateway credentials from official API keys',
 {skip:process.platform!=='darwin',timeout:45000},async t=>{
 const home=await mkdtemp(join(tmpdir(),'lake-claude-gateway-'));
 const web=join(home,'web'),cli=join(home,'claude');
 await mkdir(web);
 await writeFile(join(web,'index.html'),'fixture');
 await writeFile(cli,cliFixture('claude-code'),{mode:0o700});
 const app=await startLakeServer({home,data:join(home,'data'),port:0,staticRoot:web});
 const project=app.store.createProject('custom Claude gateway fixture');
 const agent='claude-code',base='/api/projects/'+project.id+'/external-agents';
 const models=['~fixture/flexible','fixture/compact'];
 const officialKey='synthetic-official-fixture',bearerKey='synthetic-bearer-fixture',headerKey='synthetic-header-fixture';
 const requests=[];
 const server=createServer(async (request,response)=>{
  const [gateway,version,route]=request.url.slice(1).split('/');
  const valid=gateway==='manual'?request.headers['x-api-key']===headerKey&&!request.headers.authorization:
   request.headers.authorization==='Bearer '+bearerKey&&!request.headers['x-api-key'];
  let body;
  if(request.method==='POST'){
   let data='';
   for await(const chunk of request)data+=chunk;
   body=JSON.parse(data);
  }
  requests.push({gateway,version,route,valid,method:request.method,model:body?.model,maxTokens:body?.max_tokens});
  response.setHeader('Content-Type','application/json');
  if(!valid){response.writeHead(401).end(JSON.stringify({error:'Invalid fixture token'}));return;}
  if(version==='v1'&&route==='models'){
   if(gateway==='manual'){response.writeHead(404).end();return;}
   response.end(JSON.stringify({data:[...models,'echo-'+bearerKey].map(id=>({id,capabilities:{effort:{supported:true,high:{supported:true}}}}))}));
   return;
  }
  if(version==='v1'&&route==='messages'&&models.includes(body?.model)){
   response.end(JSON.stringify({type:'message',role:'assistant',content:[{type:'text',text:'Hi'}]}));return;
  }
  response.writeHead(404).end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{
  await Promise.all([app.close(),new Promise(resolve=>server.close(resolve))]);
  await rm(home,{recursive:true,force:true});
 });
 const url='http://127.0.0.1:'+server.address().port;
 async function request(path,method='GET',body,expected=200){
  const response=await fetch(app.origin+base+path,{method,headers:{Authorization:'Bearer '+app.token,
   'Content-Type':'application/json'},...(body&&{body:JSON.stringify(body)})});
  const content=await response.text();
  for(const key of [officialKey,bearerKey,headerKey])assert.ok(!content.includes(key),'credential never appears in configuration status');
  assert.equal(response.status,expected,content);
  return JSON.parse(content);
 }
 const official=await request('/claude-code','PUT',{expectedRevision:0,enabled:false,executablePath:cli,apiKey:officialKey});
 const prepare=async (revision,settings)=>(await request('/claude-code/prepare','POST',{
  expectedRevision:revision,enabled:true,authentication:'claude-custom-api',...settings,
 })).agents.find(row=>row.id===agent);
 const invalid=await request('/claude-code/prepare','POST',{expectedRevision:official.revision,enabled:true,authentication:'claude-custom-api',
  claudeGateway:{baseURL:url+'?key=fixture',credentialHeader:'authorization'}},400);
 assert.match(invalid.error,/API 基础地址/);
 const configuration={baseURL:url+'/catalog/v1/messages/',credentialHeader:'authorization'};
 const withoutKey=await prepare(official.revision,{claudeGateway:configuration});
 assert.equal(withoutKey.keyConfigured,false);
 assert.equal(withoutKey.assignmentReady,false);
 assert.deepEqual(requests,[],'the stored official key cannot be sent to the custom service');
 const wrongKey=await prepare(withoutKey.revision,{apiKey:'synthetic-wrong-fixture'});
 assert.match(wrongKey.message,/API Key 未通过验证/);
 assert.equal(wrongKey.transportReady,false);
 const catalog=await prepare(wrongKey.revision,{apiKey:bearerKey});
 assert.equal(catalog.claudeGateway.baseURL,url+'/catalog');
 assert.deepEqual(catalog.modelOptions,models);
 assert.deepEqual(catalog.modelEffortOptions[models[0]],['high']);
 assert.equal(catalog.transportReady,true);
 assert.equal(catalog.assignmentReady,false,'a model must be picked before the executor is used');
 const selected=await prepare(catalog.revision,{modelOverride:models[0],reasoningEffortOverride:'high'});
 assert.equal(selected.assignmentReady,true);
 assert.equal(selected.defaultTaskModel,models[0]);
 assert.equal(selected.reasoningEffort,'high');
 assert.ok(requests.every(row=>row.method==='GET'&&row.version==='v1'&&row.route==='models'));

 const disabled=await prepare(selected.revision,{enabled:false});
 await request('/claude-code/probe','POST',{});
 const connectedWhileDisabled=(await request('')).agents.find(row=>row.id===agent);
 assert.equal(connectedWhileDisabled.revision,disabled.revision);
 assert.equal(connectedWhileDisabled.transportReady,true);
 assert.equal(connectedWhileDisabled.assignmentReady,false);
 const reenabled=await prepare(connectedWhileDisabled.revision,{});
 assert.equal(reenabled.assignmentReady,true);
 assert.equal(reenabled.modelOverride,models[0]);
 const specialist=app.superagent.createSpecialist(project.id,{name:'Re-enabled gateway specialist',duties:'Report a fixture',
  avatarId:'beaver',requestId:'enable-gateway-specialist'});
 assert.equal(app.superagent.setRoleExecution(project.id,specialist.roleId,{expectedRevision:specialist.roleRevision,
  execution:{kind:'acp',agent,revision:reenabled.revision}}).execution.agent,agent);

 const manual={baseURL:url+'/manual',credentialHeader:'x-api-key'};
 const beforeChange=requests.length;
 const changed=await prepare(reenabled.revision,{claudeGateway:manual});
 assert.equal(changed.keyConfigured,false);
 assert.equal(changed.modelOverride,undefined);
 assert.equal(requests.length,beforeChange,'a different endpoint cannot reuse the original gateway key');
 const manualModel=await prepare(changed.revision,{apiKey:headerKey,modelOverride:models[1]});
 assert.equal(manualModel.assignmentReady,false);
 assert.match(manualModel.message,/检测连接/);
 const beforeRefresh=requests.filter(row=>row.method==='POST').length;
 await request('');
 assert.equal(requests.filter(row=>row.method==='POST').length,beforeRefresh,'automatic refresh must not run an inference');
 await request('/claude-code/probe','POST',{});
 const verified=(await request('')).agents.find(row=>row.id===agent);
 assert.equal(verified.assignmentReady,true);
 assert.deepEqual(verified.modelOptions,[models[1]]);
 assert.deepEqual(requests.at(-1),{gateway:'manual',version:'v1',route:'messages',valid:true,method:'POST',model:models[1],maxTokens:1});
 const channel=app.superagent.createSpecialist(project.id,{name:'Gateway specialist',duties:'Report a fixture',avatarId:'beaver',requestId:'create-gateway-specialist'});
 const execution={kind:'acp',agent,revision:verified.revision};
 const binding=app.superagent.setRoleExecution(project.id,channel.roleId,{expectedRevision:channel.roleRevision,execution});
 const receipt=await app.superagent.send(channel.sessionId,'Run a fixture against the configured gateway',undefined,false,undefined,
  {requestId:'gateway-execution-fixture',roleRevision:binding.revision,execution});
 let run;
 for(let attempt=0;attempt<250;attempt++){
  run=app.store.list('acpRuns').find(row=>row.workerId===receipt.assignment.workerId);
  if(run&&!['starting','running'].includes(run.state))break;
  await new Promise(resolve=>setTimeout(resolve,35));
 }
 assert.equal(run?.state,'completed',run?.error);
 assert.deepEqual([run.model,run.modelProvider,run.summary],[models[1],'custom','ISOLATED_CLI_REPORT']);
 assert.deepEqual(requests.at(-1),{gateway:'manual',version:'v1',route:'messages',valid:true,method:'POST',model:models[1],maxTokens:2});
});
