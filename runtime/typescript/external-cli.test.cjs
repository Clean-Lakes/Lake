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
const {readFileSync}=require('node:fs');
const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const {join}=require('node:path');
const args=process.argv.slice(2);
if(args.includes('--version')){console.log(agent==='claude-code'?'2.1.332':'1.5.18');process.exit(0);}
const lines=createInterface({input:process.stdin});
const send=frame=>console.log(JSON.stringify(frame));
const response=(id,result)=>send({jsonrpc:'2.0',id,result});
assert.ok(process.env.HOME.startsWith(process.cwd()+'/'));
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
 assert.ok(process.env.ANTHROPIC_API_KEY);
 assert.equal(args[args.indexOf('--tools')+1],'');
 assert.ok(args.includes('--bare')&&args.includes('--strict-mcp-config'));
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
 assert.ok(process.env.GEMINI_API_KEY);
 assert.deepEqual(args.slice(0,4),['acp','--disable-telemetry','--agent','lake']);
 const config=join(process.env.HOME,'.gemini','config');
 const custom=readFileSync(join(config,'agents','lake.md'),'utf8');
 assert.match(custom,/tools: \[\]/);assert.match(custom,/inheritCustomizations: false/);
 const mcp=JSON.parse(readFileSync(join(config,'mcp_config.json'),'utf8')).mcpServers;
 const settings=JSON.parse(readFileSync(join(process.env.HOME,'.gemini','antigravity-cli','settings.json'),'utf8'));
 assert.ok(settings.permissions.deny.includes('command(*)'));assert.equal(settings.modelProvider,'gemini');
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
  if(frame.method==='session/new')response(frame.id,{sessionId,configOptions:[{id:'model',type:'select',category:'model',currentValue:'gemini-test',options:[{value:'gemini-test'}]}]});
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
