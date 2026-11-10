const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,mkdir,writeFile,readFile,cp,access}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('node:http');
process.env.LAKE_TS_IMPORT_ONLY='1';
const {startLakeServer}=require('../../bin/lake-runtime/server.cjs');
const adapter=process.env.LAKE_CODEX_ACP_TEST_ADAPTER;

function localCodexProvider(registry,url){
 const prepare=registry.prepareHome.bind(registry);
 registry.prepareHome=async profile=>{
  const root=await prepare(profile),path=join(root,'config.toml'),config=await readFile(path,'utf8');
  await writeFile(path,'model_provider = "fixture"\n'+config+'\n[model_providers.fixture]\nname = "Isolated Responses fixture"\nbase_url = "'+url+'"\nwire_api = "responses"\nrequires_openai_auth = false\n',{mode:0o600});
  const models=JSON.parse(await readFile(join(root,'models.json'),'utf8'));
  for(const model of models.models){model.prefer_websockets=false;model.use_responses_lite=false;}
  await writeFile(join(root,'models.json'),JSON.stringify(models),{mode:0o600});return root;
 };
}

// Opt-in integration: real pinned Codex + ACP, a local Responses fixture, and no real credentials.
test('real Codex exposes only managed tools and returns a result through the task socket',{skip:!adapter,timeout:90000},async t=>{
 const home=await mkdtemp(join(tmpdir(),'lake-codex-test-')),web=join(home,'web');await mkdir(web);await writeFile(join(web,'index.html'),'fixture');
 await writeFile(join(home,'evidence.txt'),'ACTUAL_CODEX_HOST_EVIDENCE');
 const requests=[];let reads=0,chosen;
 const provider=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks));requests.push(body);
  const tools=(body.tools??[]).flatMap(tool=>tool.type==='namespace'?(tool.tools??[]).map(item=>({...item,namespace:tool.name})):[tool]);
  const names=tools.map(tool=>tool.name).filter(Boolean);
  assert.ok(!names.some(name=>/apply_patch|exec_command|shell_command|spawn_agent|js_repl|view_image|write_stdin/.test(name)),JSON.stringify(names));
  assert.ok(names.every(name=>['Read','list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'].includes(name)),JSON.stringify(names));
  chosen=tools.find(tool=>tool.name?.endsWith('__Read')||tool.name==='Read');
  assert.ok(chosen,'Codex must receive the task-scoped Read tool: '+JSON.stringify(names));
  const hasResult=(body.input??[]).some(item=>item.type==='function_call_output'&&JSON.stringify(item.output).includes('ACTUAL_CODEX_HOST_EVIDENCE'))||requests.length>3;
  const item=requests.length===1?{id:'forged_native',type:'function_call',call_id:'forged_native',name:'apply_patch',arguments:'*** Begin Patch\n*** Add File: '+join(home,'forged.txt')+'\n+FORGED\n*** End Patch',status:'completed'}:hasResult?{id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'ACP_CODEX_REPORT: actual host read complete',annotations:[]}]}:
   {id:'fc_fixture',type:'function_call',call_id:'fixture_read',name:chosen.name,...(chosen.namespace?{namespace:chosen.namespace}:{}),arguments:JSON.stringify({file_path:'evidence.txt'}),status:'completed'};
  const response={id:'resp_'+requests.length,object:'response',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15}};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const event=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
  event('response.created',{response:{...response,status:'in_progress',output:[]}});
  event('response.output_item.added',{output_index:0,item:{...item,...(hasResult?{content:[]}:{arguments:''})}});
  if(hasResult)event('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text});
  else event('response.function_call_arguments.delta',{item_id:item.id,output_index:0,delta:item.arguments});
  event('response.output_item.done',{output_index:0,item});event('response.completed',{response});res.end();
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const app=await startLakeServer({home,data:join(home,'data'),port:0,staticRoot:web});
 t.after(async()=>{await app.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
 const response=await fetch(app.origin+'/api/projects',{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:JSON.stringify({name:'Codex isolated validation'})});
 const project=await response.json();assert.equal(response.status,200);
 const external=app.agents.external,registry=external.registry;
 await cp(adapter,registry.adapterRoot(),{recursive:true});
 await registry.save(project.id,'codex',{enabled:true,expectedRevision:0,nodePath:process.env.LAKE_CODEX_ACP_TEST_NODE??process.execPath,apiKey:'synthetic-codex-local-fixture'});
 localCodexProvider(registry,'http://127.0.0.1:'+provider.address().port+'/v1');
 const signal=AbortSignal.timeout(45000),events=[];
 const actor={projectId:project.id,taskId:'fixture-task',workerId:'fixture-worker',sessionId:'fixture-session',generation:1,deadlineAt:new Date(Date.now()+60000).toISOString(),scopeHash:'fixture-scope',workspace:home,signal,guard:()=>signal.throwIfAborted(),model:null,
  tools:[{metadata:{name:'Read',description:'Read the assigned fixture evidence'},inputSchema:{type:'object',properties:{file_path:{type:'string'}},required:['file_path'],additionalProperties:false}}],
  executeTool:async(name,input)=>{assert.equal(name,'Read');assert.equal(input.file_path,'evidence.txt');reads++;return {content:await readFile(join(home,'evidence.txt'),'utf8')};},event:(run,event)=>events.push(event)};
 let result;try{result=await external.run('codex','Read evidence.txt with the supplied Lake tool, then report the result.','fixture-one',actor);}
 catch(error){assert.fail(JSON.stringify({message:error.message,runs:app.store.list('acpRuns')}));}
 assert.equal(result.state,'completed',JSON.stringify({result,runs:app.store.list('acpRuns').map(run=>({...run,events:run.events.slice(-5)})),chosen:chosen?.name,requests:requests.slice(-2).map(request=>({names:request.tools?.map(tool=>tool.name),outputs:request.input?.filter(item=>item.type==='function_call_output').slice(-2)}))}));assert.equal(reads,1,JSON.stringify({events:events.slice(-5),outputs:requests.at(-1)?.input?.filter(item=>item.type==='function_call_output').slice(-2)}));
 assert.equal(result.verification,'insufficient');assert.ok(result.summary.includes('ACP_CODEX_REPORT'));assert.ok(requests.length>=2);
 assert.ok(requests.some(request=>JSON.stringify(request.input).includes('ACTUAL_CODEX_HOST_EVIDENCE')));
 assert.ok(requests.some(request=>JSON.stringify(request.input).includes('unsupported call: apply_patch')));
 await assert.rejects(access(join(home,'forged.txt')),'an unadvertised native write cannot execute');
 assert.equal((await external.run('codex','Read evidence.txt with the supplied Lake tool, then report the result.','fixture-one',actor)).run_id,result.run_id);
 assert.equal(reads,1,'duplicate control request must not execute the tool twice');
 const resumed=await external.run('codex','Report the previously observed fixture result.','fixture-two',actor,result.run_id);
 assert.equal(resumed.state,'completed',JSON.stringify(resumed));
 assert.equal(resumed.summary.split('ACP_CODEX_REPORT').length,2,'session/load replay is history, not a new report chunk');
 assert.equal(reads,1,'loading a completed session must not replay its old tool');
});

test('a specialist explicitly assigns a real Codex Worker and collects original task receipts and acceptance',{skip:!adapter,timeout:90000},async t=>{
 const home=await mkdtemp(join(tmpdir(),'lake-codex-assignment-')),web=join(home,'web');await mkdir(web);await writeFile(join(web,'index.html'),'fixture');
 const requests=[];let fixtureError;
 const provider=createServer(async(req,res)=>{
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));requests.push(body);
   assert.ok(Array.isArray(body.input),'the explicit Codex assignment must never call a Lake routing model');
   const tools=(body.tools??[]).flatMap(tool=>tool.type==='namespace'?(tool.tools??[]).map(item=>({...item,namespace:tool.name})):[tool]);
   const names=tools.map(tool=>tool.name).filter(Boolean);
   assert.ok(!names.some(name=>/apply_patch|exec_command|shell_command|spawn_agent|js_repl/.test(name)),JSON.stringify(names));
   const name=requests.length===1?'Read':'work_finish',chosen=tools.find(tool=>tool.name===name||tool.name?.endsWith('__'+name));
   const done=requests.length>2;
   if(!done)assert.ok(chosen,'the Codex Worker needs its original Lake tool: '+name);
   if(requests.length===2)assert.ok(JSON.stringify(body.input).includes('ACTUAL_ASSIGNED_CODEX_EVIDENCE'));
   const item=done?{id:'msg_assigned',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'ACP_CODEX_ASSIGNED_REPORT：已读取实际工作区证据并回传。',annotations:[]}]}:
    {id:'fc_assigned_'+requests.length,type:'function_call',call_id:'assigned_'+requests.length,name:chosen.name,...(chosen.namespace?{namespace:chosen.namespace}:{}),arguments:JSON.stringify(name==='Read'?{file_path:'CODEX_ASSIGNED_EVIDENCE.txt'}:{summary:'已通过 Codex 实际读取工作区证据，内容为 ACTUAL_ASSIGNED_CODEX_EVIDENCE。',outcome:'completed'}),status:'completed'};
   const response={id:'resp_assigned_'+requests.length,object:'response',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15}};
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   const event=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
   event('response.created',{response:{...response,status:'in_progress',output:[]}});
   event('response.output_item.added',{output_index:0,item:{...item,...(done?{content:[]}:{arguments:''})}});
   if(done)event('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text});
   else event('response.function_call_arguments.delta',{item_id:item.id,output_index:0,delta:item.arguments});
   event('response.output_item.done',{output_index:0,item});event('response.completed',{response});res.end();
  }catch(error){fixtureError=error;res.writeHead(500);res.end('Isolated fixture rejected request');}
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const app=await startLakeServer({home,data:join(home,'data'),port:0,staticRoot:web});
 t.after(async()=>{await app.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
 const api=async(path,method='GET',data,expected=200)=>{
  const res=await fetch(app.origin+path,{method,headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  const body=await res.json();assert.equal(res.status,expected,JSON.stringify(body));return body;
 };
 const url='http://127.0.0.1:'+provider.address().port+'/v1';
 assert.equal((await api('/api/bootstrap')).modelConfigured,false,'Codex needs no Lake inference credential');
 const project=await api('/api/projects','POST',{name:'Codex explicit assignment'}),path=`/api/projects/${project.id}`;
 const workspace=await app.store.workspace(project.id);await writeFile(join(workspace,'CODEX_ASSIGNED_EVIDENCE.txt'),'ACTUAL_ASSIGNED_CODEX_EVIDENCE');
 const superproject=await api(path+'/superagent','POST',{});
 await api(`/api/sessions/${superproject.routerSessionId}/ai/configure`,'POST',{silentReadFiles:true});
 const role={id:'e'.repeat(64),projectId:project.id,roleKey:'codex-inspector',name:'ACP 测试专员',duties:'分配执行 Agent 并收集工作区结果',revision:1};
 app.store.put('superRoles',role.id,role);await api(path+`/superagent/specialists/${role.id}/execution`,'PUT',{expectedRevision:1,execution:{kind:'native'}});
 const channel=(await api(path+'/superagent')).channels[0],registry=app.agents.external.registry;
 await cp(adapter,registry.adapterRoot(),{recursive:true});
 await registry.save(project.id,'codex',{enabled:true,expectedRevision:0,nodePath:process.env.LAKE_CODEX_ACP_TEST_NODE??process.execPath,apiKey:'synthetic-codex-assigned-fixture'});
 localCodexProvider(registry,url);await api(path+'/external-agents/codex/probe','POST',{});
 const body={text:'请读取 CODEX_ASSIGNED_EVIDENCE.txt 并报告实际内容。',assignment:{requestId:'codex-assignment-0001',roleRevision:2,execution:{kind:'acp',agent:'codex',revision:1}}};
 const receipt=await api(`/api/sessions/${channel.sessionId}/messages`,'POST',body,202);
 let result;
 for(let attempt=0;attempt<400;attempt++){
  result=await api(path+'/superagent');if(result.workers[0]?.assignmentState==='parked')break;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 if(fixtureError)throw fixtureError;
 const worker=result.workers[0],run=app.store.list('acpRuns')[0];
 assert.equal(worker?.task.state,'completed',JSON.stringify({worker,run}));assert.equal(worker.task.acceptanceState,'pass');
 assert.equal(worker.execution.backend.agent,'codex');assert.equal(worker.execution.runs[0].state,'completed');assert.equal(run.purpose,'worker');
 assert.equal(app.store.list('superOperations')[0].externalRunId,run.id);assert.equal(app.store.list('superOperations')[0].status,'succeeded');
 const page=await api(`/api/sessions/${channel.sessionId}/channel`);assert.equal(page.workers[0].execution.runs[0].id,run.id);
 assert.ok(page.workers[0].execution.runs[0].summary.includes('ACP_CODEX_ASSIGNED_REPORT'));
 const count=requests.length,again=await api(`/api/sessions/${channel.sessionId}/messages`,'POST',body,202);
 assert.equal(again.assignment.workerId,receipt.assignment.workerId);assert.equal(requests.length,count);assert.equal(app.store.list('superWorkers').length,1);
});
