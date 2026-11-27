const test=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {mkdtemp,mkdir,writeFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
process.env.LAKE_TS_IMPORT_ONLY='1';
const {startLakeServer}=require('../../bin/lake-runtime/server.cjs');
const {enableNativeSpecialistFixture} = require('./test-fixtures/native-specialists.cjs');

const content=message=>typeof message.content==='string'?message.content:(message.content??[]).map(part=>part.text??'').join('');
const toolCall=(name,args,id)=>({tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
function pilotTurn(request){
 const index=request.messages.findLastIndex(message=>message.role==='user'&&content(message).startsWith('[LAKE ADMITTED HUMAN EVENTS'));
 const input=content(request.messages[index]);
 return {event:JSON.parse(input.split('\n')[1])[0],reply:request.messages.slice(index+1),
  context:JSON.parse(input.split('[CURRENT CONVERSATION WORKING SET]\n')[1])};
}
async function until(read,predicate){
 const deadline=Date.now()+15000;let value;
 while(Date.now()<deadline){value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,20));}
 assert.fail('Timed out: '+JSON.stringify(value));
}
async function fixture(t,{count=6,failRole,hold=false,acp=false,acpScenario='conversation',summarize=false,streamReplies=false,pilotReply}={}){
 const home=await mkdtemp(join(tmpdir(),'lake-dialogue-sdk-')),web=join(home,'web');
 await mkdir(web);await writeFile(join(web,'index.html'),'<html>dialogue fixture</html>');
 const requests=[];let release;const gate=new Promise(resolve=>{release=resolve;});
 const provider=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const request=JSON.parse(Buffer.concat(chunks).toString());requests.push(request);
  const system=request.messages.filter(message=>message.role==='system').map(content).join('\n');
  const input=content([...request.messages].reverse().find(message=>message.role==='user'));
  const speaker=system.includes('personally responding in a shared conversation');
  let delta;
  if(speaker){
   const data=JSON.parse(input);
   if(hold)await gate;
   if(data.self.roleId===failRole){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'synthetic dialogue failure',type:'authentication_error'}}));return;}
   delta={content:`${data.self.number}，${data.self.name}到！`};
  }else if(system.includes('summarizing a shared conversation')){
   const data=JSON.parse(input),missing=data.members.filter(member=>member.state!=='replied').map(member=>member.name);
   delta={content:`${data.replied} / ${data.total} 位干员已回应。${missing.length?'未回应：'+missing.join('、')+'。':'全部到齐。'}`};
  }else if(pilotReply)delta=await pilotReply(pilotTurn(request),gate);
  else if(request.messages.some(message=>message.role==='tool'))delta={content:'已召集全部干员，请各自回应。'};
  else{
   const events=JSON.parse(input.match(/\[LAKE ADMITTED HUMAN EVENTS[^\n]*\n([^\n]+)/)[1]),event=events[0];
   delta=toolCall('convene_specialists',{event_id:event.id,part_key:'attendance',quote:event.text,instruction:'每位干员亲自回应',audience:'all',...(summarize===null?{}:{summarize})},'invite-'+event.id);
  }
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=part=>res.write('data: '+JSON.stringify({id:'dialogue-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:part,finish_reason:null}]})+'\n\n');
  if(speaker&&streamReplies){
   send({role:'assistant'});
   for(const character of delta.content){send({content:character});await new Promise(resolve=>setTimeout(resolve,2));}
  }else send({role:'assistant',...delta});
  res.write('data: '+JSON.stringify({id:'dialogue-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}})+'\n\n');
  res.end('data: [DONE]\n\n');
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const codexHome=join(home,'local-codex');
 if(acp){await mkdir(codexHome);await writeFile(join(codexHome,'config.toml'),'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "max"\n');await writeFile(join(codexHome,'auth.json'),JSON.stringify({tokens:{access_token:'synthetic-protocol-token'}}),{mode:0o600});}
 const app=await startLakeServer({home,codexHome,data:join(home,'data'),port:0,staticRoot:web});
 if(!acp)enableNativeSpecialistFixture(app.superagent);
 t.after(async()=>{release();await app.close();await new Promise(resolve=>provider.close(resolve));await rm(home,{recursive:true,force:true});});
 const api=async(path,method='GET',body,expected=200)=>{
  const response=await fetch(app.origin+path,{method,headers:{Authorization:`Bearer ${app.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;
 };
 await api('/api/settings/model','PUT',{url:`http://127.0.0.1:${provider.address().port}/v1/chat/completions`,name:'fixture',apiKey:'synthetic-dialogue-key'});
 const project=await api('/api/projects','POST',{name:'isolated dialogue'}),pilot=await api(`/api/projects/${project.id}/superagent`,'POST',{});
 const launches=[];
 if(acp){
  const registry=app.agents.external.registry,root=registry.runtimeRoot();
  await mkdir(join(root,'node_modules/@openai/codex/bin'),{recursive:true});
  await writeFile(registry.engineEntry(),'// owned protocol fixture');
  await writeFile(join(root,'node_modules/@openai/codex/package.json'),JSON.stringify({version:'0.170.0'}));
  app.agents.external.launch=async(_profile,directory,_signal,mcp,model)=>{
   launches.push({mcp,model});
   return {executable:process.execPath,args:[join(__dirname,'test-fixtures/codex-app-server.cjs')],cwd:directory,env:{LAKE_TEST_ACP_SCENARIO:acpScenario,LAKE_TEST_ACP_SOCKET:mcp?.args.at(-1)},observed:{model:model??'gpt-6.1-sol',modelProvider:'fixture',reasoningEffort:'max',authenticated:true,authMode:'chatgpt'}};
  };
  await registry.save(project.id,'codex',{enabled:true,expectedRevision:0,nodePath:process.execPath});
  await app.agents.external.probe(project.id,'codex',AbortSignal.timeout(5000));
 }
 const roles=Array.from({length:count},(_,i)=>({id:'role-'+i,projectId:project.id,roleKey:'fixture-'+i,name:'干员'+(i+1),duties:'亲自回应讨论',revision:1,execution:{kind:'native'}}));
 if(acp)for(const role of roles.slice(0,-1))role.execution={kind:'acp',agent:'codex',revision:1,model:{modelId:'gpt-6.1-sol'}};
 for(const role of roles)app.store.put('superRoles',role.id,role);
 const path=`/api/projects/${project.id}/superagent`;
 const start=()=>api(`/api/sessions/${pilot.routerSessionId}/messages`,'POST',{text:summarize?'全部干员亲自回应，最后请 Pilot 综合各位的意见。':summarize===false?'全部干员给我报数，各自回应即可。':'全部干员给我报数！'},202);
 return {app,api,project,pilot,roles,path,requests,launches,start,release};
}

test('HTTP and actual SDK deliver six independent replies without another Pilot summary call for roll call',async t=>{
 const f=await fixture(t);await f.start();
 const state=await until(()=>f.api(f.path),state=>state.conversations?.[0]?.state==='completed'),round=state.conversations[0];
 assert.equal(round.members.length,6);assert.ok(round.members.every(member=>member.state==='replied'));
 assert.equal(new Set(round.members.map(member=>member.sessionId)).size,6);
 const snapshot=await f.api(`/api/sessions/${f.pilot.routerSessionId}/snapshot`),messages=snapshot.messages.filter(message=>message.conversation?.id===round.id);
 assert.equal(messages.length,6);assert.deepEqual(new Set(messages.filter(message=>message.author).map(message=>message.author.roleId)),new Set(f.roles.map(role=>role.id)));
 assert.ok(messages.every(message=>message.conversation.kind==='reply'));assert.equal(round.summaryRequested,false);
 assert.equal(f.requests.filter(request=>request.messages.some(message=>message.role==='system'&&content(message).includes('summarizing a shared conversation'))).length,0);
 assert.equal(f.app.store.list('superGoals').length,0);assert.equal(f.app.store.list('superOperations').length,0);
 const speakers=f.requests.filter(request=>request.messages.some(message=>message.role==='system'&&content(message).includes('personally responding in a shared conversation')));
 assert.equal(speakers.length,6);assert.ok(speakers.every(request=>!request.tools?.length));
 for(const member of round.members){const channel=await f.api(`/api/sessions/${member.channelSessionId}/channel`);assert.equal(channel.entries.filter(entry=>entry.message?.conversation?.id===round.id).length,1);}
 await f.api(`/api/sessions/${round.members[0].sessionId}/messages`,'POST',{text:'forged'},409);
});

test('the specialist form creates one project-local profile and channel without starting work',async t=>{
 const f=await fixture(t,{count:0});
 const input={name:'  发布核对专员  ',duties:'核对发布清单\n汇报证据',avatarId:'beaver',requestId:'create-beaver'};
 const route=f.path+'/specialists';
 await f.api(route,'POST',{...input,avatarId:'unknown-animal'},400);
 await f.api(route,'POST',{...input,duties:'  '},400);
 await f.api(route,'POST',{...input,execution:{kind:'native'}},400);
 assert.deepEqual((await f.api(f.path)).channels,[]);
 const [channel,retried]=await Promise.all([f.api(route,'POST',input,201),f.api(route,'POST',input,201)]);
 assert.deepEqual(retried,channel);
 assert.equal(channel.roleName,'发布核对专员');
 assert.equal(channel.duties,input.duties);
 assert.equal(channel.avatarId,'beaver');
 assert.equal(channel.projectId,f.project.id);
 assert.equal(channel.execution.agent,'codex');
 await f.api(route,'POST',{...input,name:'修改名称'},409);
 const workspace=await f.api(f.path);
 assert.deepEqual(workspace.channels,[channel]);
 assert.deepEqual(workspace.workers,[]);
 assert.deepEqual(f.app.store.list('superInputs'),[]);
 assert.deepEqual(f.requests,[]);
 const session=f.app.store.session(channel.sessionId);
 assert.equal(session.workspaceRole,'role');
 assert.equal(session.title,channel.roleName);

 const other=await f.api('/api/projects','POST',{name:'另一项目'});
 const otherPath=`/api/projects/${other.id}/superagent`;
 assert.deepEqual((await f.api(otherPath)).channels,[]);
 const otherChannel=await f.api(otherPath+'/specialists','POST',input,201);
 assert.notEqual(otherChannel.roleId,channel.roleId);
 assert.equal(otherChannel.projectId,other.id);
});

test('Lake main chat can create a specialist and a fixed group, and group chat cannot create either',async t=>{
 const create='创建证据核对专员，头像用河狸，负责核对发布清单。请把它和干员1加入新群「发布复核群」。';
 const denied='在本群创建临时专员，并新建一个群组';
 const f=await fixture(t,{count:2,acp:true,pilotReply:({event,reply})=>{
  const source={event_id:event.id,quote:event.text};
  if(event.text===denied){
   if(reply.some(message=>message.role==='tool'))return {content:'请在 Lake 主对话新建专员和群组。'};
   return toolCall('route_work',{...source,part_key:'new-role',action:'create',role_key:'unexpected-specialist',
    new_specialist:{name:'临时专员',duties:'核对发布清单'},title:'检查清单',reason:'测试群组不能隐式创建角色'},'group-attempt');
  }
  const result=id=>reply.find(message=>message.role==='tool'&&message.tool_call_id===id);
  const created=result('save-specialist');
  if(!created)return toolCall('manage_specialist',{...source,part_key:'specialist',action:'create',role_key:'evidence-review',
   name:'证据核对专员',duties:'核对发布清单',avatar_id:'beaver'},'save-specialist');
  const specialist=JSON.parse(content(created));
  const group={...source,part_key:'release-review',title:'发布复核群',role_ids:[specialist.id,'role-0']};
  if(!result('save-group'))return toolCall('create_chat_group',group,'save-group');
  if(!result('retry-group'))return toolCall('create_chat_group',group,'retry-group');
  const saved=JSON.parse(content(result('save-group')));
  assert.deepEqual(JSON.parse(content(result('retry-group'))),saved);
  return {content:`已创建${saved.title}。`};
 }});
 const watch=new AbortController();
 const changes=await fetch(f.app.origin+'/api/jumpserver/events',{headers:{Authorization:`Bearer ${f.app.token}`},signal:watch.signal});
 assert.equal(changes.status,200);
 const catalog=changes.body.getReader();
 await catalog.read();
 const pilotSession=`/api/sessions/${f.pilot.routerSessionId}`;
 try{
  await f.api(pilotSession+'/messages','POST',{text:create},202);
  let previousApprovalId;
  for(const groupCount of [0,1]){
   const {pending}=await until(()=>f.api(pilotSession+'/ai'),view=>view.pending?.call.name==='create_chat_group'&&view.pending.id!==previousApprovalId);
   assert.equal(f.app.store.list('superChatGroups').length,groupCount);
   previousApprovalId=pending.id;
   await f.api(pilotSession+'/ai/decision','POST',{id:pending.id,accept:true});
  }
  await until(()=>f.api(pilotSession+'/snapshot'),view=>view.messages.some(message=>message.text==='已创建发布复核群。'));
  const change=await Promise.race([catalog.read(),new Promise(resolve=>{
   const timer=setTimeout(()=>resolve({}),1600);timer.unref();
  })]);
  assert.match(Buffer.from(change.value??[]).toString(),/event: catalog/);
 }finally{watch.abort();}
 const workspace=await f.api(f.path),specialist=workspace.channels.find(row=>row.roleName==='证据核对专员');
 assert.equal(specialist.avatarId,'beaver');
 assert.equal(workspace.chatGroups.length,1);
 const [group]=workspace.chatGroups;
 assert.deepEqual(group.members.map(member=>member.roleId),[specialist.roleId,'role-0']);
 assert.ok((await f.api('/api/catalog')).sessions.some(session=>session.id===group.sessionId&&session.workspaceRole==='group'));
 assert.ok(f.requests.some(request=>request.tools?.some(tool=>tool.function.name==='create_chat_group')));
 assert.deepEqual(f.app.store.messages(group.sessionId),[]);

 const groupSession=`/api/sessions/${group.sessionId}`;
 await f.api(groupSession+'/messages','POST',{text:denied},202);
 await until(()=>f.api(groupSession+'/snapshot'),view=>view.messages.some(message=>message.text==='请在 Lake 主对话新建专员和群组。'));
 const groupRequests=f.requests.filter(request=>pilotTurn(request).event.text===denied);
 assert.ok(groupRequests.length);
 assert.ok(groupRequests.every(request=>!request.tools?.some(tool=>['create_chat_group','manage_specialist'].includes(tool.function.name))));
 assert.match(JSON.stringify(groupRequests.map(pilotTurn).flatMap(turn=>turn.reply)),/群组只可派单给固定成员/);
 const after=await f.api(f.path);
 assert.equal(after.chatGroups.length,1);
 assert.equal(after.channels.length,workspace.channels.length);
 for(const table of ['superGoals','superWorkers','acpRuns'])assert.equal(f.app.store.list(table).length,0,table);
});

test('groups save a fixed roster and use separate continuous Pilot conversations',async t=>{
 const f=await fixture(t,{count:3,pilotReply:async({event},gate)=>{
  if(event.text==='各位好')await gate;
  return {content: `Pilot 收到「${event.text}」。`};
 }});
 const roleIds=f.roles.slice(0,2).map(role=>role.id);
 const input={title:'运维协作群',roleIds,requestId:'group-a'};
 const group=await f.api(f.path+'/groups','POST',input,201);
 assert.deepEqual(await f.api(f.path+'/groups','POST',input,201),group);
 await f.api(f.path+'/groups','POST',{...input,title:'不同的群名'},409);
 await f.api(f.path+'/groups','POST',{...input,requestId:'single',roleIds:roleIds.slice(0,1)},400);
 const other=await f.api(f.path+'/groups','POST',{title:'发布协调群',roleIds:f.roles.slice(1).map(role=>role.id),requestId:'group-b'},201);
 const foreign=await f.api('/api/projects','POST',{name:'another project'});
 const foreignPath=`/api/projects/${foreign.id}/superagent/groups`;
 await f.api(foreignPath,'POST',input,404);
 assert.deepEqual(group.members.map(member=>member.roleId),roleIds);
 assert.ok((await f.api('/api/catalog')).sessions.some(session=>session.id===group.sessionId&&session.workspaceRole==='group'));

 const send=f.path+'/groups/'+group.sessionId+'/messages';
 const request={text:'各位好',requestId:'first'};
 const first=await f.api(send,'POST',request,202);
 assert.equal((await f.api(send,'POST',request,202)).id,first.id);
 await f.api(send,'POST',{...request,text:'不同的消息'},409);
 await f.api(foreignPath+'/'+group.sessionId+'/messages','POST',request,404);
 await until(()=>f.requests,requests=>requests.length===1);
 const groupPath=`/api/sessions/${group.sessionId}`;
 const second=await f.api(groupPath+'/messages','POST',{text:'结合前文继续'},202);
 assert.equal(second.pilotSessionId,group.sessionId);
 assert.deepEqual((await f.api(groupPath+'/snapshot')).messages.map(message=>message.id),[first.id,second.id]);
 f.release();
 const settled=await until(()=>f.api(groupPath+'/snapshot'),result=>result.messages.filter(message=>message.role==='assistant').length===2);
 assert.deepEqual(settled.messages.filter(message=>message.role==='assistant').map(message=>[message.text,message.replyToMessageId]),[
  ['Pilot 收到「各位好」。',first.id],['Pilot 收到「结合前文继续」。',second.id],
 ]);
 assert.equal(settled.chatGroupRounds?.length??0,0);
 assert.deepEqual((await f.api(f.path)).conversations,[]);
 assert.deepEqual(f.app.store.messages(f.pilot.routerSessionId),[]);
 assert.equal((await f.api(f.path)).chatGroups.find(row=>row.sessionId===group.sessionId).latest.text,settled.messages.at(-1).text);
 assert.deepEqual(f.app.store.messages(other.sessionId),[]);

 const otherPath=`/api/sessions/${other.sessionId}`;
 await f.api(otherPath+'/messages','POST',{text:'这是发布群的首条消息'},202);
 await until(()=>f.api(otherPath+'/snapshot'),result=>result.messages.some(message=>message.role==='assistant'));
 const turns=f.requests.map(pilotTurn);
 assert.ok(turns.find(turn=>turn.event.text==='结合前文继续').context.dialogue.some(message=>message.text===request.text));
 const otherContext=turns.find(turn=>turn.event.text==='这是发布群的首条消息').context;
 assert.ok(otherContext.dialogue.every(message=>message.sourceSessionId===other.sessionId));
 assert.deepEqual(new Set(otherContext.specialists.items.map(role=>role.id)),new Set(other.members.map(member=>member.roleId)));
 assert.ok(f.requests.every(request=>request.tools?.some(tool=>tool.function?.name==='route_work')&&
  !request.tools?.some(tool=>tool.function?.name==='manage_specialist')));
 for(const table of ['superGoals','superOperations','acpRuns'])assert.equal(f.app.store.list(table).length,0,table);
});

test('Lake and two groups bind their own Pilot models and can save while another group is replying', async t => {
 const f = await fixture(t, {count: 2, pilotReply: async ({event}, gate) => {
  if (event.text === 'group A') await gate;
  return {content: `收到 ${event.text}`};
 }});
 const roleIds = f.roles.map(role => role.id);
 const groupA = await f.api(f.path + '/groups', 'POST', {title: '甲群', roleIds, requestId: 'model-a'}, 201);
 const groupB = await f.api(f.path + '/groups', 'POST', {title: '乙群', roleIds, requestId: 'model-b'}, 201);
 const provider = (await f.api('/api/settings/providers')).providers[0];
 for (const name of ['model-a', 'model-b', 'model-lake']) {
  provider.models.push({id: name, name, enabled: true, reasoningCapability: {levels: ['low', 'high']}});
 }
 await f.api(`/api/settings/providers/${provider.id}`, 'PUT', provider);
 const paths = [groupA.sessionId, groupB.sessionId, f.pilot.routerSessionId].map(id => `/api/sessions/${id}`);
 const save = (index, modelId, status = 200) => f.api(paths[index] + '/ai/model', 'POST', {providerId: provider.id, modelId}, status);
 const send = (index, text) => f.api(paths[index] + '/messages', 'POST', {text, ignoreProjectMemory: true}, 202);
 const stateA = await save(0, 'model-a');
 await f.api(paths[0] + '/ai/reasoning', 'POST', {modelId: stateA.modelId, effort: 'low'});
 await send(0, 'group A');
 await until(() => f.requests, requests => requests.length === 1);
 await save(0, 'model-b', 409);
 const stateB = await save(1, 'model-b');
 const stateLake = await save(2, 'model-lake');
 await f.api(paths[1] + '/ai/reasoning', 'POST', {modelId: stateB.modelId, effort: 'high'});
 f.release();
 await send(1, 'group B');
 await send(2, 'Lake');
 for (const path of paths) await until(() => f.api(path + '/snapshot'), snap => snap.messages.some(message => message.role === 'assistant'));
 assert.deepEqual(f.requests.map(request => [pilotTurn(request).event.text, request.model, request.reasoning_effort]), [
  ['group A', 'model-a', 'low'], ['group B', 'model-b', 'high'], ['Lake', 'model-lake', undefined],
 ]);
 for (const [index, state] of [stateA, stateB, stateLake].entries()) {
  assert.deepEqual((await f.api(paths[index] + '/snapshot')).model, state);
 }
 assert.equal((await f.api('/api/bootstrap')).modelName, 'fixture');
});

test('an explicit group invitation uses text-only Codex for the selected roster',async t=>{
 const f=await fixture(t,{count:3,acp:true});
 const group=await f.api(f.path+'/groups','POST',{title:'协作讨论',roleIds:f.roles.slice(0,2).map(role=>role.id),requestId:'codex-group'},201);
 await f.api(`/api/sessions/${group.sessionId}/messages`,'POST',{text:'请本群成员分别回应'},202);
 const state=await until(()=>f.api(f.path),result=>result.conversations.some(round=>round.sessionId===group.sessionId&&round.state==='completed'));
 const round=state.conversations.find(round=>round.sessionId===group.sessionId);
 const view=await f.api(`/api/sessions/${group.sessionId}/snapshot`);
 const replies=view.messages.filter(message=>message.conversation?.kind==='reply');
 assert.equal(replies.length,2);
 assert.deepEqual(new Set(replies.map(reply=>reply.author.roleId)),new Set(group.members.map(member=>member.roleId)));
 assert.ok(replies.every(reply=>reply.author.execution.kind==='acp'));
 assert.ok(f.launches.every(launch=>launch.mcp===undefined));
 const runs=f.app.store.list('acpRuns');
 assert.equal(new Set(runs.map(run=>run.externalSessionId)).size,2);
 assert.ok(runs.every(run=>run.purpose==='conversation'&&run.conversationId===round.id));
 assert.deepEqual(f.app.store.messages(f.pilot.routerSessionId),[]);
});

test('group Pilot runs Codex work for a member and keeps the task, events and report in that group',async t=>{
 const f=await fixture(t,{count:3,acp:true,acpScenario:'group-work',pilotReply:({event,reply})=>{
  if(reply.some(message=>message.role==='tool'))return {content:'已处理分派请求。'};
  return toolCall('route_work',{event_id:event.id,part_key:'inspect',action:'create',role_id:event.text.startsWith('群外')?'role-2':'role-0',
   title:'核对项目目录',quote:event.text,reason:'用户请求核对项目目录'},'dispatch-'+event.id);
 }});
 const group=await f.api(f.path+'/groups','POST',{title:'协作讨论',roleIds:['role-0','role-1'],requestId:'group-work'},201);
 const other=await f.api(f.path+'/groups','POST',{title:'其他讨论',roleIds:['role-0','role-2'],requestId:'other-work'},201);
 const path=`/api/sessions/${group.sessionId}`;
 const label='@干员3';
 await f.api(path+'/messages','POST',{text:label,mentions:[{kind:'role',id:'role-2',label,start:0,end:label.length}]},403);
 const refused=await f.api(path+'/messages','POST',{text:'群外专员核对项目目录'},202);
 await until(()=>f.api(path+'/snapshot'),view=>view.messages.some(message=>message.role==='assistant'));
 assert.equal(f.app.store.list('superWorkers').length,0);
 assert.match(JSON.stringify(f.requests.map(pilotTurn).find(turn=>turn.event.text===refused.text&&turn.reply.some(row=>row.role==='tool'))?.reply),/群组只可派单给固定成员/);

 const request=await f.api(path+'/messages','POST',{text:'请群内专员核对项目目录'},202);
 const view=await until(()=>f.api(path+'/snapshot'),result=>result.messages.some(message=>message.author?.kind==='specialist'&&message.replyToMessageId===request.id));
 const report=view.messages.find(message=>message.author?.kind==='specialist');
 const {workers}=await f.api(f.path);
 assert.equal(workers.length,1);
 const [worker]=workers;
 assert.equal(worker.roleId,'role-0');
 assert.equal(worker.pilotSessionId,group.sessionId);
 assert.equal(worker.sourceSessionId,group.sessionId);
 assert.equal(worker.pilotSourceMessageId,request.id);
 assert.equal(worker.pilotReport.messageId,report.id);
 assert.equal(report.author.execution.kind,'acp');
 assert.match(report.text,/读取实际项目文件/);
 assert.equal(f.launches.filter(launch=>launch.mcp).length,1);
 assert.equal((await f.api(`/api/sessions/${worker.sessionId}/snapshot`)).superagent.pilotSessionId,group.sessionId);
 assert.deepEqual(f.app.store.messages(f.pilot.routerSessionId),[]);
 assert.deepEqual(f.app.store.messages(other.sessionId),[]);

 for(const session of [f.pilot.routerSessionId,other.sessionId]){
  await f.api(`/api/sessions/${session}/messages`,'POST',{text:'继续已有任务',taskId:worker.task.taskId},404);
  await f.api(`/api/sessions/${session}/events?worker=${worker.sessionId}`,'GET',undefined,404);
 }
 const controller=new AbortController();
 try {
  const stream=await fetch(`${f.app.origin}${path}/events?worker=${worker.sessionId}`,{
   headers:{Authorization:`Bearer ${f.app.token}`},signal:controller.signal});
  assert.equal(stream.status,200);
  assert.match(stream.headers.get('Content-Type'),/text\/event-stream/);
 } finally {controller.abort();}
 const followup=await f.api(path+'/messages','POST',{text:'继续已有任务',taskId:worker.task.taskId},202);
 assert.equal(followup.taskReference.taskId,worker.task.taskId);
});

test('stopping a group leaves another group involving the same specialist active',async t=>{
 const f=await fixture(t,{count:3,hold:true});
 const group=await f.api(f.path+'/groups','POST',{title:'当前群',roleIds:['role-0','role-1'],requestId:'stop-a'},201);
 const other=await f.api(f.path+'/groups','POST',{title:'另一群',roleIds:['role-0','role-2'],requestId:'stop-b'},201);
 for(const sessionId of [group.sessionId,other.sessionId])
  await f.api(`/api/sessions/${sessionId}/messages`,'POST',{text:'请本群成员报到'},202);
 const scopes=()=>f.api(f.path).then(value=>new Map(value.conversations.map(round=>[round.sessionId,round])));
 await until(scopes,rounds=>[group,other].every(row=>rounds.get(row.sessionId)?.members.every(member=>member.state==='running')));
 await f.api(f.path+'/stop','POST',{routerSessionId:group.sessionId});
 const stopped=await scopes();
 assert.equal(stopped.get(group.sessionId).state,'cancelled');
 assert.equal(stopped.get(other.sessionId).state,'running');
 f.release();
 await until(scopes,rounds=>rounds.get(other.sessionId).state==='completed');
 assert.equal(f.app.store.messages(group.sessionId).filter(message=>message.conversation?.kind==='reply').length,0);
 assert.equal(f.app.store.messages(other.sessionId).filter(message=>message.conversation?.kind==='reply').length,2);
});

test('a failed specialist remains absent without triggering a redundant summary or a substitute reply',async t=>{
 const f=await fixture(t,{count:3,failRole:'role-1'});await f.start();
 const state=await until(()=>f.api(f.path),state=>state.conversations?.[0]?.state==='completed'),round=state.conversations[0];
 assert.deepEqual(round.members.map(member=>member.state),['replied','failed','replied']);
 assert.equal(round.members[1].reason,'模型服务鉴权失败（HTTP 401）');
 const messages=f.app.store.messages(f.pilot.routerSessionId).filter(message=>message.conversation?.id===round.id);
 assert.equal(messages.length,2);assert.ok(messages.every(message=>message.conversation.kind==='reply'&&message.author.roleId!=='role-1'));
 assert.equal(f.app.store.list('superAcceptance').length,0);
 const saved=f.app.store.get('superConversations',round.id);
 saved.members[1].reason='回应失败，未收到完整回复';
 f.app.store.put('superConversations',round.id,saved);
 const history=await f.api(f.path);
 assert.equal(history.conversations[0].members[1].reason,'模型服务鉴权失败（HTTP 401）','older generic labels can use their exact stored diagnostic');
 assert.equal(f.app.store.get('superConversations',round.id).members[1].reason,saved.members[1].reason,'reading the reason does not rewrite historical results');
});

test('eight speakers start together and publish only lifecycle changes and real replies',async t=>{
 const f=await fixture(t,{count:8,failRole:'role-3',streamReplies:true,hold:true});await f.start();
 const speakers=()=>f.requests.filter(request=>request.messages.some(message=>message.role==='system'&&content(message).includes('personally responding in a shared conversation')));
 await until(speakers,requests=>requests.length===8);
 const working=(await f.api(f.path)).conversations[0];
 assert.ok(working.members.every(member=>member.state==='running'),'all eight enter inference before any response is released');
 f.release();
 const state=await until(()=>f.api(f.path),state=>state.conversations?.[0]?.state==='completed'),round=state.conversations[0];
 assert.equal(round.members.filter(member=>member.state==='replied').length,7);
 const routerEvents=f.app.store.events(f.pilot.routerSessionId,0);
 const channelEvents=round.members.map(member=>f.app.store.events(member.channelSessionId,0));
 const individual=round.members.flatMap(member=>f.app.store.events(member.sessionId,0));
 const channelNotifications=channelEvents.map(events=>events.filter(event=>['message','specialist'].includes(event.type)));
 t.diagnostic(JSON.stringify({router:routerEvents.length,channels:channelNotifications.flat().length,individual:individual.length}));
 assert.ok(individual.some(event=>event.textUpdate),'the individual session still delivers model text');
 assert.equal(routerEvents.filter(event=>event.conversationProgress).length,11);
 assert.ok(routerEvents.filter(event=>event.type==='specialist').length<=15,'model deltas do not invalidate the Pilot transcript');
 assert.ok(channelNotifications.every(events=>events.length===3),'each channel receives only its own queue, start and outcome');
 assert.equal(channelNotifications.flat().filter(event=>event.type==='message').length,7);
});

test('eight specialists, including a legacy native role, reply through separate Codex sessions',async t=>{
 const f=await fixture(t,{count:8,acp:true});await f.start();
 const state=await until(()=>f.api(f.path),state=>state.conversations?.[0]?.state==='completed'),round=state.conversations[0];
 assert.equal(round.members.length,8);assert.ok(round.members.every(member=>member.state==='replied'),JSON.stringify(round.members));
 const runs=f.app.store.list('acpRuns');assert.equal(runs.length,8);
 assert.equal(new Set(runs.map(run=>run.externalSessionId)).size,8);
 for(const run of runs){
  assert.equal(run.purpose,'conversation');assert.equal(run.conversationId,round.id);assert.equal(run.taskId,undefined);
  const member=round.members.find(member=>member.sessionId===run.sessionId);assert.ok(member);
  assert.equal(run.workerId,member.id);assert.equal(run.requestedModel,'gpt-6.1-sol');assert.equal(run.state,'completed');
 }
 assert.ok(f.launches.every(launch=>launch.mcp===undefined));
 assert.equal(f.launches.filter(launch=>launch.model==='gpt-6.1-sol').length,8);
 const replies=f.app.store.messages(f.pilot.routerSessionId).filter(message=>message.conversation?.id===round.id);
 assert.equal(replies.length,8);assert.ok(replies.every(message=>message.conversation.kind==='reply'));
 assert.ok(replies.every(message=>message.author?.execution?.kind==='acp'));
 for(const table of ['superGoals','superWorkers','superOperations','superAcceptance'])assert.equal(f.app.store.list(table).length,0,table);
 const native=f.requests.filter(request=>request.messages.some(message=>message.role==='system'&&content(message).includes('personally responding in a shared conversation')));
 assert.equal(native.length,0);
 assert.equal(f.app.store.get('superRoles',f.roles.at(-1).id).execution.kind,'native','the stored legacy binding is retained');
});

test('a multi-specialist Pilot round concludes automatically from the settled replies',async t=>{
 const f=await fixture(t,{count:2,summarize:null});await f.start();
 const state=await until(()=>f.api(f.path),state=>state.conversations?.[0]?.state==='completed'),round=state.conversations[0];
 const messages=f.app.store.messages(f.pilot.routerSessionId).filter(message=>message.conversation?.id===round.id);
 assert.equal(round.summaryRequested,true);assert.equal(messages.length,3);
 assert.equal(messages.at(-1).conversation.kind,'summary');assert.equal(messages.at(-1).conversation.summaryRequested,true);
 assert.equal(messages.at(-1).text,'2 / 2 位干员已回应。全部到齐。');
 assert.equal(f.requests.filter(request=>request.messages.some(message=>message.role==='system'&&content(message).includes('summarizing a shared conversation'))).length,1);
});

test('HTTP Pilot stop cancels active/queued dialogue and late SDK output cannot produce attendance or a summary',async t=>{
 const f=await fixture(t,{count:3,hold:true});await f.start();
 const running=await until(()=>f.api(f.path),state=>state.conversations?.[0]?.members.some(member=>member.state==='running'));
 await f.api(f.path+'/stop','POST',{routerSessionId:f.pilot.routerSessionId});f.release();
 const state=await f.api(f.path);assert.equal(state.conversations[0].state,'cancelled');
 assert.ok(state.conversations[0].members.every(member=>member.state==='cancelled'));
 assert.equal(f.app.store.messages(f.pilot.routerSessionId).filter(message=>message.conversation?.id===running.conversations[0].id).length,0);
});
