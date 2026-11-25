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
async function until(read,predicate){
 const deadline=Date.now()+15000;let value;
 while(Date.now()<deadline){value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,20));}
 assert.fail('Timed out: '+JSON.stringify(value));
}
async function fixture(t,{count=6,failRole,hold=false,acp=false,summarize=false,streamReplies=false}={}){
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
  }else if(request.messages.some(message=>message.role==='tool'))delta={content:'已召集全部干员，请各自回应。'};
  else{
   const events=JSON.parse(input.match(/\[LAKE ADMITTED HUMAN EVENTS[^\n]*\n([^\n]+)/)[1]),event=events[0];
   delta={tool_calls:[{index:0,id:'invite-'+event.id,type:'function',function:{name:'convene_specialists',arguments:JSON.stringify({event_id:event.id,part_key:'attendance',quote:event.text,instruction:'每位干员亲自回应',audience:'all',...(summarize===null?{}:{summarize})})}}]};
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
   return {executable:process.execPath,args:[join(__dirname,'test-fixtures/codex-app-server.cjs')],cwd:directory,env:{LAKE_TEST_ACP_SCENARIO:'conversation',LAKE_TEST_ACP_SOCKET:mcp?.args.at(-1)},observed:{model:model??'gpt-6.1-sol',modelProvider:'fixture',reasoningEffort:'max',authenticated:true,authMode:'chatgpt'}};
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

test('project groups save their selected roster and deliver text only to the exact group and turn',async t=>{
 const f=await fixture(t,{count:3,hold:true});
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
 const request={text:'只在运维协作群讨论',requestId:'first'};
 const first=await f.api(send,'POST',request,202);
 assert.equal((await f.api(send,'POST',request,202)).id,first.id);
 await f.api(send,'POST',{...request,text:'不同的消息'},409);
 await f.api(send,'POST',{...request,requestId:'while-working'},409);
 await f.api(foreignPath+'/'+group.sessionId+'/messages','POST',request,404);
 await f.api(`/api/sessions/${group.sessionId}/messages`,'POST',request,409);
 await until(()=>f.requests,requests=>requests.length===2);
 f.release();
 const snapshot=()=>f.api(`/api/sessions/${group.sessionId}/snapshot`);
 const settled=await until(snapshot,result=>result.chatGroupRounds?.[0]?.state==='completed');
 assert.deepEqual(settled.messages.map(message=>message.role),['user','assistant','assistant']);
 assert.deepEqual(new Set(settled.messages.slice(1).map(message=>message.author.roleId)),new Set(roleIds));
 assert.ok(settled.messages.slice(1).every(message=>message.conversation.sourceMessageId===first.id));
 assert.deepEqual((await f.api(f.path)).conversations,[]);
 assert.deepEqual(f.app.store.messages(f.pilot.routerSessionId),[]);
 assert.ok(settled.chatGroupRounds[0].members.every(member=>f.app.store.messages(member.channelSessionId).length===0));
 assert.equal((await f.api(f.path)).chatGroups.find(row=>row.sessionId===group.sessionId).latest.text,settled.messages.at(-1).text);
 assert.deepEqual(f.app.store.messages(other.sessionId),[]);

 await f.api(send,'POST',{text:'结合前文继续',requestId:'second'},202);
 await until(snapshot,result=>result.chatGroupRounds?.[1]?.state==='completed');
 await f.api(f.path+'/groups/'+other.sessionId+'/messages','POST',{text:'这是发布群的首条消息',requestId:'first'},202);
 await until(()=>f.api(`/api/sessions/${other.sessionId}/snapshot`),result=>result.chatGroupRounds?.[0]?.state==='completed');
 const turns=f.requests.map(request=>JSON.parse(content([...request.messages].reverse().find(message=>message.role==='user'))));
 assert.ok(turns.filter(turn=>turn.originalHumanRequest==='结合前文继续').every(turn=>turn.dialogue.some(message=>message.text===request.text)));
 assert.ok(turns.filter(turn=>turn.originalHumanRequest==='这是发布群的首条消息').every(turn=>turn.dialogue.length===0));
 assert.ok(f.requests.every(request=>!request.tools?.length));
 for(const table of ['superInputs','superGoals','superOperations'])assert.equal(f.app.store.list(table).length,0,table);
});

test('group replies use the verified text-only Codex profile for every selected member',async t=>{
 const f=await fixture(t,{count:2,acp:true});
 const group=await f.api(f.path+'/groups','POST',{title:'协作讨论',roleIds:f.roles.map(role=>role.id),requestId:'codex-group'},201);
 await f.api(f.path+'/groups/'+group.sessionId+'/messages','POST',{text:'请分别回应',requestId:'first'},202);
 const view=await until(()=>f.api('/api/sessions/'+group.sessionId+'/snapshot'),snapshot=>snapshot.chatGroupRounds?.[0]?.state==='completed');
 const replies=view.messages.filter(message=>message.role==='assistant');
 assert.equal(replies.length,2);
 assert.ok(replies.every(reply=>reply.author.execution.kind==='acp'));
 assert.ok(f.launches.every(launch=>launch.mcp===undefined));
 const runs=f.app.store.list('acpRuns');
 assert.equal(new Set(runs.map(run=>run.externalSessionId)).size,2);
 assert.ok(runs.every(run=>run.purpose==='conversation'&&run.conversationId===view.chatGroupRounds[0].id));
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
