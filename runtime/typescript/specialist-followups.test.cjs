const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,mkdir,writeFile,readFile,cp,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('node:http');
process.env.LAKE_TS_IMPORT_ONLY='1';
const {startLakeServer}=require('../../bin/lake-runtime/server.cjs');
const {enableNativeSpecialistFixture} = require('./test-fixtures/native-specialists.cjs');
const codexRuntime=process.env.LAKE_CODEX_APP_SERVER_TEST_RUNTIME;
const content=message=>typeof message.content==='string'?message.content:(message.content??[]).map(part=>part.text??'').join('');
async function until(read,check){
 for(const end=Date.now()+30000;Date.now()<end;){const value=await read();if(check(value))return value;await new Promise(resolve=>setTimeout(resolve,20));}
 assert.fail('isolated specialist did not consume the expected supplement');
}

for(const backend of ['native','codex'])for(const boundary of backend==='native'?['question','native-question','long-question','native-long-question','guide']:['question','long-question','guide'])
test(`${backend} specialist consumes a Pilot supplement during ${boundary} in the same invocation`,
 {skip:backend==='codex'&&!codexRuntime,timeout:90000},async t=>{
 const clarification=boundary.includes('long')?'SYNTHETIC_LONG_CONTEXT：'+'x'.repeat(16280)+' COMPLETE_SUPPLEMENT_TAIL':
  'SYNTHETIC_FOLLOWUP_CONTEXT：使用测试源配置与测试凭据引用。';
 assert.ok(Buffer.byteLength(clarification)<=16384);
 const home=await mkdtemp(join(tmpdir(),'lake-specialist-followup-')),web=join(home,'web');
 await mkdir(web);await writeFile(join(web,'index.html'),'isolated supplement validation');
 let app,fixtureError,releaseFirst,held=false,workerRequests=0,sequence=0;
 const wait=(read,check)=>until(async()=>{if(fixtureError)throw fixtureError;return read();},check);
 const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
 const observed=[];
 const provider=createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url?.split('?')[0].endsWith('/models')){res.writeHead(404);res.end();return;}
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks)),requestId=++sequence;
   const codex=Array.isArray(body.input),messages=codex?body.input:body.messages;
   const tools=codex?(body.tools??[]).flatMap(tool=>tool.type==='namespace'?(tool.tools??[]).map(item=>({...item,namespace:tool.name})):[tool]):
    (body.tools??[]).map(tool=>tool.function);
   const router=tools.some(tool=>tool.name==='route_work');
   let toolCall,text;
   if(router){
    const admitted=[...messages].reverse().find(message=>message.role==='user'&&content(message).startsWith('[LAKE ADMITTED HUMAN EVENTS'));
    const event=JSON.parse(content(admitted).split('\n')[1])[0];
    const after=messages.slice(messages.indexOf(admitted)+1),routed=after.some(message=>message.tool_calls?.some(call=>call.function.name==='route_work'));
    const pages=after.filter(message=>message.role==='tool').flatMap(message=>{
     try{const value=JSON.parse(content(message));return value.id===event.id&&typeof value.content==='string'?[value]:[];}catch{return [];}
    });
    if(event.clipped&&!pages.at(-1)?.complete){
     toolCall={name:'read_super_object',input:{kind:'event',id:event.id,revision:event.revision,expected_hash:event.hash,offset:pages.at(-1)?.nextOffset??0,limit:16384}};
    }else if(!routed){
     const quote=event.clipped?JSON.parse(pages.map(page=>page.content).join('')).payload:event.text;
     const worker=app.store.list('superWorkers')[0];
     toolCall={name:'route_work',input:{event_id:event.id,part_key:'task',quote,role_id:'followup-test-role',reason:'exact current synthetic requirement',
      ...(worker?{action:'followup',task_id:worker.taskId}:{action:'create',title:'验证同任务补充'})}};
    }else text='已记录给测试专员的补充或任务。';
   }else{
    workerRequests++;observed.push(body);
    if(boundary==='guide'&&!held){held=true;await firstGate;}
    const calls=codex?messages.filter(item=>item.type==='function_call').map(item=>item.name):
     messages.flatMap(message=>message.tool_calls??[]).map(call=>call.function.name);
    if(!calls.length){
     toolCall=boundary==='guide'?{name:'work_read',input:{}}:boundary.startsWith('native-')?
      {name:'AskUserQuestion',input:{questions:[{question:'Which test source should be used?',header:'Source',options:[{label:'Source A',description:'First source'},{label:'Source B',description:'Second source'}],multiSelect:false}]}}:
      {name:'ask_user_question',input:{questions:[{id:'source',title:'Which test source should be used?'}]}};
    }else if(!calls.some(name=>name.endsWith('work_finish'))){
     assert.ok(JSON.stringify(messages).includes(clarification),'the next provider request must contain the actual supplement');
     if(boundary!=='guide')assert.ok(JSON.stringify(messages).includes('superseded'),'question resumes as new context, not selected answers');
     toolCall={name:'work_finish',input:{summary:'已读取补充并完成本地测试判断。',outcome:'completed'}};
    }else text='已读取补充并完成本地测试判断。';
   }
   const chosen=toolCall&&tools.find(tool=>tool.name===toolCall.name||tool.name?.endsWith('__'+toolCall.name));
   if(toolCall)assert.ok(chosen,'the exact task tool must be advertised: '+toolCall.name);
   if(!codex){
    const message=toolCall?{role:'assistant',content:null,tool_calls:[{id:'call-'+requestId+'-'+toolCall.name,type:'function',function:{name:chosen.name,arguments:JSON.stringify(toolCall.input)}}]}:{role:'assistant',content:text};
    if(body.stream){
     const delta={...message,...(toolCall?{tool_calls:message.tool_calls.map(call=>({index:0,...call}))}:{})};
     res.writeHead(200,{'Content-Type':'text/event-stream'});
     res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
     res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:toolCall?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');return;
    }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message,finish_reason:toolCall?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));return;
   }
   const item=toolCall?{id:'item-'+workerRequests,type:'function_call',call_id:'call-'+workerRequests,name:chosen.name,...(chosen.namespace?{namespace:chosen.namespace}:{}),arguments:JSON.stringify(toolCall.input),status:'completed'}:
    {id:'message-'+workerRequests,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]};
   const response={id:'response-'+workerRequests,object:'response',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15}};
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   const event=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
   event('response.created',{response:{...response,status:'in_progress',output:[]}});
   event('response.output_item.added',{output_index:0,item:{...item,...(toolCall?{arguments:''}:{content:[]})}});
   if(toolCall)event('response.function_call_arguments.delta',{item_id:item.id,output_index:0,delta:item.arguments});
   else event('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:text});
   event('response.output_item.done',{output_index:0,item});event('response.completed',{response});res.end();
  }catch(error){fixtureError=error;res.writeHead(500);res.end('isolated supplement fixture rejected request');}
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{releaseFirst();await app?.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await rm(home,{recursive:true,force:true});});
 app=await startLakeServer({home,data:join(home,'data'),codexHome:join(home,'codex-home'),port:0,staticRoot:web});
 enableNativeSpecialistFixture(app.superagent);
 const api=async(path,method='GET',data,status=200)=>{
  const response=await fetch(app.origin+path,{method,headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;
 };
 await api('/api/settings/model','PUT',{url:`http://127.0.0.1:${provider.address().port}/native/v1/chat/completions`,name:'fixture',apiKey:'synthetic-test-credential'});
 const project=await api('/api/projects','POST',{name:'isolated specialist supplement'});
 const pilot=await api(`/api/projects/${project.id}/superagent`,'POST',{}),session=pilot.routerSessionId;
 let execution={kind:'native'};
 if(backend==='codex'){
  const external=app.agents.external,registry=external.registry,source=registry.local.home;
  await mkdir(join(registry.runtimeRoot(),'node_modules'),{recursive:true});
  await cp(join(codexRuntime,'node_modules/@openai'),join(registry.runtimeRoot(),'node_modules/@openai'),{recursive:true});
  await mkdir(source,{recursive:true});
  await writeFile(join(source,'config.toml'),`model = "gpt-6.1-sol"\nmodel_reasoning_effort = "max"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Isolated followup fixture"\nbase_url = "http://127.0.0.1:${provider.address().port}/codex/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,{mode:0o600});
  await writeFile(join(source,'auth.json'),'{}',{mode:0o600});
  const prepare=registry.prepareModelCatalog.bind(registry);registry.prepareModelCatalog=async (...args)=>{
   const path=await prepare(...args),models=JSON.parse(await readFile(path,'utf8'));
   for(const model of models.models){model.prefer_websockets=false;model.use_responses_lite=false;}
   await writeFile(path,JSON.stringify(models),{mode:0o600});return path;
  };
  const binary=process.env.LAKE_CODEX_TEST_MCP_BINARY;
  if(binary){const launch=external.launch.bind(external);external.launch=(profile,directory,signal,mcp,model,purpose)=>{
   if(mcp){const end=mcp.args.indexOf('LAKE_TS_IMPORT_ONLY=0');assert.ok(end>=0);mcp={command:mcp.command,args:[...mcp.args.slice(0,end+1),binary,'--internal-acp-mcp',mcp.args.at(-1)]};}
   return launch(profile,directory,signal,mcp,model,purpose);
  };}
  await registry.save(project.id,'codex',{enabled:true,expectedRevision:0,nodePath:process.execPath});
  await external.probe(project.id,'codex',AbortSignal.timeout(30000));
  execution={kind:'acp',agent:'codex',revision:registry.get(project.id,'codex').revision,model:{modelId:'gpt-6.1-sol'}};
 }
 app.store.put('superRoles','followup-test-role',{id:'followup-test-role',projectId:project.id,roleKey:'followup-test',name:'补充测试专员',duties:'仅处理本地合成数据',revision:1,execution});
 await api(`/api/sessions/${session}/messages`,'POST',{text:'请测试专员判断应该使用哪个测试源。'},202);
 const worker=await wait(async()=>app.store.list('superWorkers')[0],worker=>worker&&
  (boundary==='guide'?held:app.store.view(worker.sessionId).status==='waiting_input'));
 const generation=worker.generation;
 await api(`/api/sessions/${session}/messages`,'POST',{text:clarification},202);
 await wait(async()=>app.store.list('superInputs'),events=>events.length===2&&events.every(event=>event.disposition==='routed'));
 if(boundary==='guide'){
  await wait(async()=>app.store.list('superInputDeliveries'),rows=>rows.length===1&&rows[0].state==='queued');
  assert.deepEqual(app.store.get('superWorkers',worker.id).invocationInputIds,[worker.sourceEventId],'RPC or SDK queuing alone does not consume the supplement');
  releaseFirst();
 }
 await wait(async()=>({goal:app.store.get('superGoals',worker.taskId),worker:app.store.get('superWorkers',worker.id)}),value=>value.goal.status==='completed'&&value.worker.state==='parked');
 if(fixtureError)throw fixtureError;
 const latest=app.store.get('superWorkers',worker.id),deliveries=app.store.list('superInputDeliveries');
 assert.equal(app.store.list('superWorkers').length,1);assert.equal(latest.generation,generation);
 assert.equal(latest.invocationInputIds.length,2);assert.equal(deliveries.length,1);assert.equal(deliveries[0].state,'consumed');
 assert.equal(deliveries[0].via,boundary==='guide'?'guide':'question');
 assert.equal(app.store.view(worker.sessionId).question,undefined);assert.equal(app.store.list('superOperations').length,0,'synthetic context handling performs no resource operations');
 assert.equal(app.store.list('acpRuns').length,backend==='codex'?1:0);
 assert.ok(observed.some(body=>JSON.stringify(body).includes(clarification)));
 const questionCalls=observed.flatMap(body=>body.input?body.input.filter(item=>item.type==='function_call'&&['ask_user_question','AskUserQuestion'].some(name=>item.name===name||item.name.endsWith('__'+name))).map(item=>item.call_id):body.messages.flatMap(message=>message.tool_calls??[]).filter(call=>['ask_user_question','AskUserQuestion'].includes(call.function.name)).map(call=>call.id));
 if(boundary!=='guide')assert.equal(new Set(questionCalls).size,1,'the supplied clarification prevents repeating the original prerequisite');
});
