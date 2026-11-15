/* Installed Lake Dev verification. Only disposable isolated data and a local
 * deterministic model are used. Keep running for UI inspection; POST /finish
 * to the metadata controlOrigin releases fixtures and closes MCP clients. */
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const {Client}=require(path.join(root,'third_party/agent-sdk/node_modules/@modelcontextprotocol/client'));
const {StdioClientTransport}=require(path.join(root,'third_party/agent-sdk/node_modules/@modelcontextprotocol/client/dist/stdio.cjs'));
const metadata=process.argv[2]??'/tmp/lake-incoming-channels-dev.json';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const content=message=>typeof message.content==='string'?message.content:(message.content??[]).map(part=>part.text??'').join('');
async function until(read,predicate,ms=30000){let value;for(const end=Date.now()+ms;Date.now()<end;){value=await read();if(predicate(value))return value;await sleep(50);}throw new Error('Validation timed out: '+JSON.stringify(value));}
const clients=[],gates=new Map();let releasePublish=false,preview=false,roles=[];
const waitGate=name=>{if(!gates.has(name)){let release;const wait=new Promise(r=>release=r);gates.set(name,{wait,release});}return gates.get(name);};
const tool=(name,args,index=0)=>({index,id:`fixture-${name}-${index}`,type:'function',function:{name,arguments:JSON.stringify(args)}});
(async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'lake-incoming-channels-dev-')),data=path.join(home,'custom web data');
 const results={model:'deterministic local HTTP fixture',checks:[]};let requests=0;
 const provider=http.createServer(async(req,res)=>{
  if(req.url==='/release'){releasePublish=true;for(const gate of gates.values())gate.release();res.end('ok');return;}
  if(req.url==='/finish'){for(const gate of gates.values())gate.release();await Promise.allSettled(clients.map(client=>client.close()));res.end('ok');provider.close();return;}
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const request=JSON.parse(Buffer.concat(chunks));requests++;
   const tools=request.tools??[],router=tools.some(t=>t.function?.name==='route_work'),worker=tools.some(t=>t.function?.name==='work_finish')&&!router;
   let delta;
   if(router){
    const marker=request.messages.findLast(m=>m.role==='user'&&content(m).startsWith('[LAKE ADMITTED HUMAN EVENTS'));
    const event=JSON.parse(content(marker).split('\n')[1])[0],current=request.messages.slice(request.messages.indexOf(marker));
    const names=current.flatMap(m=>m.tool_calls??[]).map(call=>call.function.name);
    if(event.text==='配置隔离验证专员'){
     delta=names.includes('manage_specialist')?{content:'已创建两位隔离验证专员。'}:{tool_calls:[
      tool('manage_specialist',{event_id:event.id,part_key:'setup-health',action:'create',role_key:'health',name:'服务器运维排查专员',duties:'隔离健康检查，无业务资源。',execution:{kind:'native'},quote:event.text}),
      tool('manage_specialist',{event_id:event.id,part_key:'setup-publish',action:'create',role_key:'publish',name:'发布专员',duties:'隔离发布核对，无业务资源。',execution:{kind:'native'},quote:event.text},1)]};
    }else if(names.includes('route_work')){
     delta={content:event.text==='信息不足'?'请提供项目名称。':event.text==='项目是 Lake'?'收到，项目是 Lake。':event.text.startsWith('直接回复')?event.text.replace('直接回复','回复'):'已安排两项任务。'};
    }else if(event.text==='固定专员检查'){
     delta={tool_calls:[tool('route_work',{event_id:event.id,part_key:'fixed-task',action:'create',role_id:roles[0].roleId,title:'固定入口健康检查',quote:event.text,reason:'验证固定专员入口'})]};
    }else if(event.text.includes('检查服务健康')){
     delta={tool_calls:roles.map((role,index)=>tool('route_work',{event_id:event.id,part_key:`task-${index}`,action:'create',role_id:role.roleId,title:index?'发布记录核对':'服务健康检查',quote:index?'核对最近一次发布是否有异常':'检查服务健康',reason:'隔离验证同一消息的多项任务'},index))};
    }else{
     delta={tool_calls:[tool('route_work',{event_id:event.id,part_key:'reply',action:event.text==='信息不足'?'ask':'respond',quote:event.text,reason:'隔离会话验证'})]};
    }
   }else if(worker){
    const all=request.messages.map(content).join('\n'),names=request.messages.flatMap(m=>m.tool_calls??[]).map(call=>call.function.name);
    const publication=all.includes('发布记录核对');
    if(publication&&(!releasePublish||preview))await waitGate(preview?'preview':'publish').wait;
    delta=names.includes('work_finish')?{content:'隔离验证完成。'}:{tool_calls:[tool('work_finish',{summary:publication?'发布记录已核对，未发现异常。':'3 项检查完成，未发现异常。',outcome:'completed'})]};
   }else delta={content:'隔离测试。'};
   if(res.destroyed)return;
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   for(const [part,finish] of [[{role:'assistant',...delta},null],[{},delta.tool_calls?'tool_calls':'stop']])res.write('data: '+JSON.stringify({id:'incoming-channel-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:part,finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}})+'\n\n');
   res.end('data: [DONE]\n\n');
  }catch(error){if(!res.destroyed){res.writeHead(500);res.end(JSON.stringify({error:'fixture failure'}));}console.error(error.message);}
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const controlOrigin='http://127.0.0.1:'+provider.address().port;
 const app=path.join(os.homedir(),'Applications/Lake Dev.app');
 const build=JSON.parse(await fs.readFile(path.join(app,'Contents/Resources/build-origin.json'),'utf8'));
 results.build=build;
 const log=await fs.open(path.join(home,'native.log'),'w',0o600);
 const native=spawn(path.join(app,'Contents/MacOS/Lake'),['--lake-home',home,'--lake-data',data],{stdio:['ignore',log.fd,log.fd]});await log.close();
 native.on('error',error=>console.error('Native app launch failed: '+error.message));
 const runtime=await until(async()=>{try{return JSON.parse(await fs.readFile(path.join(data,'runtime.json'),'utf8'));}catch{return null;}},value=>value?.origin);
 const api=async(url,method='GET',body,expected)=>{const response=await fetch(runtime.origin+url,{method,headers:{Authorization:'Bearer '+runtime.token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();if(expected)assert.equal(response.status,expected,JSON.stringify(value));else assert.ok(response.ok,JSON.stringify(value));return value;};
 await api('/api/settings/model','PUT',{url:controlOrigin+'/v1/chat/completions',name:'fixture',apiKey:'synthetic-isolated-dev-key'});
 const project=await api('/api/projects','POST',{name:'HexHub 渠道隔离验证'}),pilot=await api('/api/projects/'+project.id+'/superagent','POST',{});
 await api('/api/sessions/'+pilot.routerSessionId+'/messages','POST',{text:'配置隔离验证专员'});
 roles=await until(async()=>(await api('/api/settings/gateway/specialists')).specialists.filter(role=>role.projectId===project.id),value=>value.length===2);
 roles.sort((a,b)=>a.roleKey==='health'?-1:b.roleKey==='health'?1:0);
 await until(async()=>(await api('/api/sessions/'+pilot.routerSessionId+'/snapshot')).ai.status,value=>value==='completed');
 const first=await api('/api/settings/gateway/connections','POST',{name:'我的 Codex',projectId:project.id,routing:{mode:'pilot'}});
 const second=await api('/api/settings/gateway/connections','POST',{name:'研发 Claude Code',projectId:project.id,routing:{mode:'pilot'}});
 const third=await api('/api/settings/gateway/connections','POST',{name:'本机调试',projectId:project.id,routing:{mode:'pilot'}});
 await api('/api/settings/gateway/connections/'+third.id,'PATCH',{enabled:false});
 const {command}=await api('/api/settings/gateway/connections');assert.equal(command.data,await fs.realpath(data));
 async function connect(connection){
  const client=new Client({name:'lake-incoming-dev-validation',version:'1.0.0'},{capabilities:{}});clients.push(client);
  await client.connect(new StdioClientTransport({command:command.program,args:[...(command.script?[command.script]:[]),'--mcp-channel','--home',command.home,'--data',command.data,'--connection',connection.id],stderr:'pipe'}));
  const names=(await client.listTools()).tools.map(tool=>tool.name);assert.deepEqual(names.sort(),['get_message_status','send_message','test_connection','wait_message'].sort());
  const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,content(result));return JSON.parse(result.content.find(c=>c.type==='text').text);};
  return {client,call,send:(text,key,thread='release-check',extra={})=>call('send_message',{text,thread_id:thread,thread_title:'发布前检查',client_message_id:key,...extra}),status:id=>call('get_message_status',{message_id:id}),wait:(id,seconds=20)=>call('wait_message',{message_id:id,timeout_seconds:seconds})};
 }
 const a=await connect(first),b=await connect(second),before=requests;await a.call('test_connection');assert.equal(requests,before,'testing a connection must not start a model');
 results.checks.push({name:'signed installed stdio, custom data path and read-only connection test',pass:true});
 const receipts=await Promise.all(Array.from({length:8},()=>a.send('检查服务健康，并核对最近一次发布是否有异常。','multi-task-0001')));
 assert.equal(new Set(receipts.map(r=>r.instructionId)).size,1);assert.equal(receipts.filter(r=>r.duplicate).length,7);
 const instructionId=receipts[0].instructionId;
 const partial=await until(()=>a.status(instructionId),row=>row.tasks.length===2&&row.replies.some(reply=>reply.from==='specialist'));
 assert.equal(partial.state,'running');assert.equal(partial.tasks.filter(task=>task.goalState==='completed').length,1);
 assert.ok(partial.tasks.every(task=>task.sessionId&&task.roleId&&task.roleName));
 const started=Date.now(),timed=await a.wait(instructionId,1);assert.equal(timed.state,'running');assert.ok(Date.now()-started<1800);
 results.checks.push({name:'concurrent duplicate admits once, two tasks wait for all reports, bounded wait',pass:true,taskCount:2,elapsedMs:Date.now()-started});
 releasePublish=true;waitGate('publish').release();const complete=await a.wait(instructionId);assert.equal(complete.state,'replied');assert.equal(new Set(complete.replies.filter(r=>r.from==='specialist').map(r=>r.taskId)).size,2);
 for(const task of complete.tasks){const snapshot=await api('/api/sessions/'+task.sessionId+'/snapshot?taskId='+task.taskId);assert.equal(snapshot.session.projectId,project.id);}
 results.checks.push({name:'both task reports and exact existing task sessions',pass:true});
 const foreign=await b.client.callTool({name:'get_message_status',arguments:{message_id:instructionId}});assert.equal(foreign.isError,true);
 const isolated=await b.send('直接回复另一连接','multi-task-0001');assert.notEqual(isolated.instructionId,instructionId);assert.equal((await b.wait(isolated.instructionId)).tasks.length,0);
 const asked=await a.send('信息不足','ask-0001','clarify');assert.equal((await a.wait(asked.instructionId)).state,'waiting_input');
 const answered=await a.send('项目是 Lake','answer-0001','clarify',{reply_to:asked.instructionId});assert.equal((await a.wait(answered.instructionId)).state,'replied');
 results.checks.push({name:'connection isolation, independent idempotency and clarification continuation',pass:true});
 await api('/api/settings/gateway/connections/'+second.id,'PATCH',{enabled:false});const denied=await b.client.callTool({name:'send_message',arguments:{text:'停用后拒绝',thread_id:'release-check',client_message_id:'disabled-0001'}});assert.equal(denied.isError,true);
 await api('/api/settings/gateway/connections/'+second.id,'PATCH',{enabled:true});
 results.checks.push({name:'disabled connection immediately rejects requests',pass:true});
 const fixed=await api('/api/settings/gateway/connections','POST',{name:'临时固定专员验证',projectId:project.id,routing:{mode:'specialist',roleId:roles[0].roleId}}),fixedClient=await connect(fixed);
 const fixedReceipt=await fixedClient.send('固定专员检查','fixed-task-0001'),fixedResult=await fixedClient.wait(fixedReceipt.instructionId);
 assert.equal(fixedReceipt.roleId,roles[0].roleId);assert.equal(fixedResult.state,'replied');assert.equal(fixedResult.tasks.length,1);assert.equal(fixedResult.tasks[0].roleId,roles[0].roleId);
 await api('/api/settings/gateway/connections/'+fixed.id,'DELETE');
 results.checks.push({name:'fixed specialist routing uses one bound existing specialist task',pass:true});
 preview=true;const ui=await a.send('界面预览：检查服务健康，并核对最近一次发布是否有异常。','ui-preview-0001','preview');
 await until(()=>a.status(ui.instructionId),row=>row.tasks.length===2&&row.replies.some(reply=>reply.from==='specialist'));
 const safe={home,data:await fs.realpath(data),origin:runtime.origin,projectId:project.id,pilotSessionId:pilot.routerSessionId,connectionId:first.id,previewMessageId:ui.instructionId,controlOrigin,nativePid:native.pid,results};
 await fs.writeFile(metadata,JSON.stringify(safe,null,2),{mode:0o600});
 console.log(JSON.stringify({ready:true,metadata,origin:runtime.origin,home,checks:results.checks}));
})().catch(error=>{console.error(error.stack??error);process.exitCode=1;setTimeout(()=>process.exit(1),1000).unref();});
