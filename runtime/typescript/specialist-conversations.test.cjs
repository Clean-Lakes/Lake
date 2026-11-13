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
async function fixture(t,{count=6,failRole,hold=false,acp=false,summarize=false}={}){
 const home=await mkdtemp(join(tmpdir(),'lake-dialogue-sdk-')),web=join(home,'web');
 await mkdir(web);await writeFile(join(web,'index.html'),'<html>dialogue fixture</html>');
 const requests=[];let release;const gate=new Promise(resolve=>{release=resolve;});
 const provider=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const request=JSON.parse(Buffer.concat(chunks).toString());requests.push(request);
  const system=request.messages.filter(message=>message.role==='system').map(content).join('\n');
  const input=content([...request.messages].reverse().find(message=>message.role==='user'));
  let delta;
  if(system.includes('personally responding in a shared conversation')){
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
   delta={tool_calls:[{index:0,id:'invite-'+event.id,type:'function',function:{name:'convene_specialists',arguments:JSON.stringify({event_id:event.id,part_key:'attendance',quote:event.text,instruction:'每位干员亲自回应',audience:'all',...(summarize?{summarize:true}:{})})}}]};
  }
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write('data: '+JSON.stringify({id:'dialogue-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',...delta},finish_reason:null}]})+'\n\n');
  res.write('data: '+JSON.stringify({id:'dialogue-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}})+'\n\n');
  res.end('data: [DONE]\n\n');
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const codexHome=join(home,'local-codex');
 if(acp){await mkdir(codexHome);await writeFile(join(codexHome,'config.toml'),'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "max"\n');await writeFile(join(codexHome,'auth.json'),JSON.stringify({tokens:{access_token:'synthetic-protocol-token'}}),{mode:0o600});}
 const app=await startLakeServer({home,codexHome,data:join(home,'data'),port:0,staticRoot:web});
 t.after(async()=>{release();await app.close();await new Promise(resolve=>provider.close(resolve));await rm(home,{recursive:true,force:true});});
 const api=async(path,method='GET',body,expected=200)=>{
  const response=await fetch(app.origin+path,{method,headers:{Authorization:`Bearer ${app.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;
 };
 await api('/api/settings/model','PUT',{url:`http://127.0.0.1:${provider.address().port}/v1/chat/completions`,name:'fixture',apiKey:'synthetic-dialogue-key'});
 const project=await api('/api/projects','POST',{name:'isolated dialogue'}),pilot=await api(`/api/projects/${project.id}/superagent`,'POST',{});
 const launches=[];
 if(acp){
  const registry=app.agents.external.registry,root=registry.adapterRoot();
  await mkdir(join(root,'node_modules/@agentclientprotocol/codex-acp/dist'),{recursive:true});
  await writeFile(join(root,'node_modules/@agentclientprotocol/codex-acp/package.json'),JSON.stringify({version:'2.2.2'}));
  await writeFile(registry.adapterEntry(),'// owned protocol fixture');
  await mkdir(join(root,'node_modules/@openai/codex'),{recursive:true});
  await writeFile(join(root,'node_modules/@openai/codex/package.json'),JSON.stringify({version:'0.160.1'}));
  app.agents.external.launch=async(_profile,directory,_signal,mcp,model)=>{
   launches.push({mcp,model});
   return {executable:process.execPath,args:[join(__dirname,'test-fixtures/codex-acp.cjs')],cwd:directory,env:{LAKE_TEST_ACP_SCENARIO:'conversation',LAKE_TEST_ACP_SOCKET:mcp?.args.at(-1)},observed:{model:model??'gpt-6.1-sol',modelProvider:'fixture',reasoningEffort:'max',authenticated:true,authMode:'chatgpt'}};
  };
  await registry.save(project.id,'codex',{enabled:true,expectedRevision:0,nodePath:process.execPath});
  await app.agents.external.probe(project.id,'codex',AbortSignal.timeout(5000));
 }
 const roles=Array.from({length:count},(_,i)=>({id:'role-'+i,projectId:project.id,roleKey:'fixture-'+i,name:'干员'+(i+1),duties:'亲自回应讨论',revision:1,execution:{kind:'native'}}));
 if(acp)for(const role of roles.slice(0,-1))role.execution={kind:'acp',agent:'codex',revision:1,model:{modelId:'gpt-6.1-sol'}};
 for(const role of roles)app.store.put('superRoles',role.id,role);
 const path=`/api/projects/${project.id}/superagent`;
 const start=()=>api(`/api/sessions/${pilot.routerSessionId}/messages`,'POST',{text:summarize?'全部干员亲自回应，最后请 Pilot 综合各位的意见。':'全部干员给我报数！'},202);
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

test('a failed specialist remains absent without triggering a redundant summary or a substitute reply',async t=>{
 const f=await fixture(t,{count:3,failRole:'role-1'});await f.start();
 const state=await until(()=>f.api(f.path),state=>state.conversations?.[0]?.state==='completed'),round=state.conversations[0];
 assert.deepEqual(round.members.map(member=>member.state),['replied','failed','replied']);
 const messages=f.app.store.messages(f.pilot.routerSessionId).filter(message=>message.conversation?.id===round.id);
 assert.equal(messages.length,2);assert.ok(messages.every(message=>message.conversation.kind==='reply'&&message.author.roleId!=='role-1'));
 assert.equal(f.app.store.list('superAcceptance').length,0);
});

test('configured ACP and native specialists reply together through separate identities without creating business tasks or MCP transports',async t=>{
 const f=await fixture(t,{count:3,acp:true});await f.start();
 const state=await until(()=>f.api(f.path),state=>state.conversations?.[0]?.state==='completed'),round=state.conversations[0];
 assert.deepEqual(round.members.map(member=>member.state),['replied','replied','replied']);
 const runs=f.app.store.list('acpRuns');assert.equal(runs.length,2);
 assert.equal(new Set(runs.map(run=>run.externalSessionId)).size,2);
 for(const run of runs){
  assert.equal(run.purpose,'conversation');assert.equal(run.conversationId,round.id);assert.equal(run.taskId,undefined);
  const member=round.members.find(member=>member.sessionId===run.sessionId);assert.ok(member);
  assert.equal(run.workerId,member.id);assert.equal(run.requestedModel,'gpt-6.1-sol');assert.equal(run.state,'completed');
 }
 assert.ok(f.launches.every(launch=>launch.mcp===undefined));
 assert.equal(f.launches.filter(launch=>launch.model==='gpt-6.1-sol').length,2);
 const replies=f.app.store.messages(f.pilot.routerSessionId).filter(message=>message.conversation?.id===round.id);
 assert.equal(replies.length,3);assert.ok(replies.every(message=>message.conversation.kind==='reply'));
 assert.equal(replies.filter(message=>message.author?.execution?.kind==='acp').length,2);
 for(const table of ['superGoals','superWorkers','superOperations','superAcceptance'])assert.equal(f.app.store.list(table).length,0,table);
 const native=f.requests.filter(request=>request.messages.some(message=>message.role==='system'&&content(message).includes('personally responding in a shared conversation')));
 assert.equal(native.length,1,'ACP speakers must not be silently routed through the native model');
});

test('only an explicit request for synthesis creates a separate Pilot summary with requested provenance',async t=>{
 const f=await fixture(t,{count:2,summarize:true});await f.start();
 const state=await until(()=>f.api(f.path),state=>state.conversations?.[0]?.state==='completed'),round=state.conversations[0];
 const messages=f.app.store.messages(f.pilot.routerSessionId).filter(message=>message.conversation?.id===round.id);
 assert.equal(round.summaryRequested,true);assert.equal(messages.length,3);
 assert.equal(messages.at(-1).conversation.kind,'summary');assert.equal(messages.at(-1).conversation.summaryRequested,true);
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
