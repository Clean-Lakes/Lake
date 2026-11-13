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
async function fixture(t,{count=6,failRole,hold=false}={}){
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
   delta={tool_calls:[{index:0,id:'invite-'+event.id,type:'function',function:{name:'convene_specialists',arguments:JSON.stringify({event_id:event.id,part_key:'attendance',quote:event.text,instruction:'每位干员亲自报数',audience:'all'})}}]};
  }
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write('data: '+JSON.stringify({id:'dialogue-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',...delta},finish_reason:null}]})+'\n\n');
  res.write('data: '+JSON.stringify({id:'dialogue-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}})+'\n\n');
  res.end('data: [DONE]\n\n');
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const app=await startLakeServer({home,data:join(home,'data'),port:0,staticRoot:web});
 t.after(async()=>{release();await app.close();await new Promise(resolve=>provider.close(resolve));await rm(home,{recursive:true,force:true});});
 const api=async(path,method='GET',body,expected=200)=>{
  const response=await fetch(app.origin+path,{method,headers:{Authorization:`Bearer ${app.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;
 };
 await api('/api/settings/model','PUT',{url:`http://127.0.0.1:${provider.address().port}/v1/chat/completions`,name:'fixture',apiKey:'synthetic-dialogue-key'});
 const project=await api('/api/projects','POST',{name:'isolated dialogue'}),pilot=await api(`/api/projects/${project.id}/superagent`,'POST',{});
 const roles=Array.from({length:count},(_,i)=>({id:'role-'+i,projectId:project.id,roleKey:'fixture-'+i,name:'干员'+(i+1),duties:'亲自回应讨论',revision:1}));
 for(const role of roles)app.store.put('superRoles',role.id,role);
 const path=`/api/projects/${project.id}/superagent`;
 const start=()=>api(`/api/sessions/${pilot.routerSessionId}/messages`,'POST',{text:'全部干员给我报数！'},202);
 return {app,api,project,pilot,roles,path,requests,start,release};
}

test('HTTP and actual SDK deliver six independent specialist replies and one final Pilot summary to the same conversation',async t=>{
 const f=await fixture(t);await f.start();
 const state=await until(()=>f.api(f.path),state=>state.conversations?.[0]?.state==='completed'),round=state.conversations[0];
 assert.equal(round.members.length,6);assert.ok(round.members.every(member=>member.state==='replied'));
 assert.equal(new Set(round.members.map(member=>member.sessionId)).size,6);
 const snapshot=await f.api(`/api/sessions/${f.pilot.routerSessionId}/snapshot`),messages=snapshot.messages.filter(message=>message.conversation?.id===round.id);
 assert.equal(messages.length,7);assert.deepEqual(new Set(messages.filter(message=>message.author).map(message=>message.author.roleId)),new Set(f.roles.map(role=>role.id)));
 assert.equal(messages.at(-1).text,'6 / 6 位干员已回应。全部到齐。');assert.equal(messages.at(-1).conversation.kind,'summary');
 assert.equal(f.app.store.list('superGoals').length,0);assert.equal(f.app.store.list('superOperations').length,0);
 const speakers=f.requests.filter(request=>request.messages.some(message=>message.role==='system'&&content(message).includes('personally responding in a shared conversation')));
 assert.equal(speakers.length,6);assert.ok(speakers.every(request=>!request.tools?.length));
 for(const member of round.members){const channel=await f.api(`/api/sessions/${member.channelSessionId}/channel`);assert.equal(channel.entries.filter(entry=>entry.message?.conversation?.id===round.id).length,1);}
 await f.api(`/api/sessions/${round.members[0].sessionId}/messages`,'POST',{text:'forged'},409);
});

test('a specialist provider failure is visible as absent and Pilot receives the real partial attendance',async t=>{
 const f=await fixture(t,{count:3,failRole:'role-1'});await f.start();
 const state=await until(()=>f.api(f.path),state=>state.conversations?.[0]?.state==='completed'),round=state.conversations[0];
 assert.deepEqual(round.members.map(member=>member.state),['replied','failed','replied']);
 const messages=f.app.store.messages(f.pilot.routerSessionId).filter(message=>message.conversation?.id===round.id);
 assert.equal(messages.length,3);assert.equal(messages.at(-1).text,'2 / 3 位干员已回应。未回应：干员2。');
 assert.equal(f.app.store.list('superAcceptance').length,0);
});

test('HTTP Pilot stop cancels active/queued dialogue and late SDK output cannot produce attendance or a summary',async t=>{
 const f=await fixture(t,{count:3,hold:true});await f.start();
 const running=await until(()=>f.api(f.path),state=>state.conversations?.[0]?.members.some(member=>member.state==='running'));
 await f.api(f.path+'/stop','POST',{routerSessionId:f.pilot.routerSessionId});f.release();
 const state=await f.api(f.path);assert.equal(state.conversations[0].state,'cancelled');
 assert.ok(state.conversations[0].members.every(member=>member.state==='cancelled'));
 assert.equal(f.app.store.messages(f.pilot.routerSessionId).filter(message=>message.conversation?.id===running.conversations[0].id).length,0);
});
