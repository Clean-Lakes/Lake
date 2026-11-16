const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,mkdir,writeFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createServer}=require('node:http');
process.env.LAKE_TS_IMPORT_ONLY='1';
const {startLakeServer}=require('../../bin/lake-runtime/server.cjs');

const content=message=>typeof message.content==='string'?message.content:(message.content??[]).map(part=>part.text??'').join('');
async function until(read,check){
 for(const end=Date.now()+15000;Date.now()<end;){const value=await read();if(check(value))return value;await new Promise(resolve=>setTimeout(resolve,25));}
 assert.fail('isolated continuous input did not reach its expected state');
}

test('HTTP Pilot admits B/C during an active SDK turn, preserves paused drafts and binds each reply to its actual source',async t=>{
 const home=await mkdtemp(join(tmpdir(),'lake-pilot-continuous-'));
 let releaseA;const gateA=new Promise(resolve=>{releaseA=resolve;});
 const requests=[];let firstClosed=false,finishedA=false;
 const provider=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  const admitted=[...body.messages].reverse().find(message=>message.role==='user'&&content(message).startsWith('[LAKE ADMITTED HUMAN EVENTS'));
  const events=JSON.parse(content(admitted).split('\n')[1]);requests.push(events);
  const first=events[0].text.startsWith('A：');
  if(first){res.once('close',()=>{if(!finishedA)firstClosed=true;});await gateA;}
  if(res.destroyed)return;
  const text='已回应 '+events[0].text;
  if(body.stream!==true){finishedA||=first;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}]}));return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})+'\n\n');
  finishedA||=first;
  res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
 let app;
 t.after(async()=>{releaseA();await app?.close();provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await rm(home,{recursive:true,force:true});});
 const web=join(home,'web');await mkdir(web);await writeFile(join(web,'index.html'),'<html>isolated continuous input</html>');
 const options={home,data:join(home,'data'),port:0,staticRoot:web,codexHome:join(home,'empty-codex')};
 app=await startLakeServer(options);
 const api=async(path,method='GET',data,status=200)=>{
  const response=await fetch(app.origin+path,{method,headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  assert.equal(response.status,status);return response.json();
 };
 await api('/api/settings/model','PUT',{url:`http://127.0.0.1:${provider.address().port}/v1/chat/completions`,name:'fixture',apiKey:'synthetic-continuous-fixture-key'});
 const project=await api('/api/projects','POST',{name:'isolated continuous Pilot'});
 const pilot=await api(`/api/projects/${project.id}/superagent`,'POST',{}),session=pilot.routerSessionId;
 const a=await api(`/api/sessions/${session}/messages`,'POST',{text:'A：先解释原有记录。'},202);
 await until(async()=>requests,rows=>rows.length===1);
 const draft=await api(`/api/sessions/${session}/messages`,'POST',{text:'保留的旧草稿',enqueue:true},202);
 await api(`/api/sessions/${session}/message-queue`,'POST',{operation:'pause',revision:draft.messageQueue.revision});
 const b=await api(`/api/sessions/${session}/messages`,'POST',{text:'B：请说明新的独立要求。'},202);
 const c=await api(`/api/sessions/${session}/messages`,'POST',{text:'C：再说明补充要求。'},202);
 assert.equal(b.queued,undefined);assert.equal(c.queued,undefined);assert.ok(b.id&&c.id);
 const during=await api(`/api/sessions/${session}/snapshot`);
 assert.equal(during.ai.status,'running');assert.deepEqual(during.ai.sourceMessageIds,[a.id]);
 assert.deepEqual(during.replyTimings.map(timing=>[timing.messageId,timing.status]),[[a.id,'running']]);
 assert.ok(during.messages.some(message=>message.id===b.id));assert.ok(during.messages.some(message=>message.id===c.id));
 assert.equal(during.messageQueue.paused,true);assert.deepEqual(during.messageQueue.items.map(item=>item.text),['保留的旧草稿']);
 assert.equal(requests.length,1);assert.equal(firstClosed,false,'B/C do not cancel the in-flight A model request');
 releaseA();
 const ended=await until(()=>api(`/api/sessions/${session}/snapshot`),s=>s.ai.status==='completed'&&s.messages.some(m=>m.replyToMessageId===c.id));
 assert.deepEqual(requests.map(events=>events.map(event=>event.text)),[['A：先解释原有记录。'],['B：请说明新的独立要求。'],['C：再说明补充要求。']]);
 for(const message of [a,b,c]){
  const replies=ended.messages.filter(reply=>reply.role==='assistant'&&reply.replyToMessageId===message.id);
  assert.equal(replies.length,1);assert.equal(replies[0].text,'已回应 '+message.text);
  assert.ok(ended.ai.cards.some(card=>card.data?.source_message_id===message.id&&card.content===replies[0].text));
  const timing=ended.replyTimings.find(timing=>timing.messageId===message.id);
  assert.equal(timing.status,'completed');assert.ok(Date.parse(timing.finishedAt)>=Date.parse(timing.startedAt));
 }
 assert.equal(firstClosed,false);assert.equal(ended.messageQueue.items.length,1);assert.equal(ended.messageQueue.paused,true);
 await app.close();app=await startLakeServer(options);
 const restored=await api(`/api/sessions/${session}/snapshot`);
 assert.deepEqual(restored.ai.sourceMessageIds,[c.id]);
 assert.deepEqual(restored.replyTimings,ended.replyTimings);
 assert.deepEqual(restored.messages.filter(m=>m.replyToMessageId).map(m=>[m.replyToMessageId,m.text]),
  ended.messages.filter(m=>m.replyToMessageId).map(m=>[m.replyToMessageId,m.text]));
 assert.equal(restored.messageQueue.items.length,1);assert.equal(restored.messageQueue.paused,true);
 assert.equal(requests.length,3,'restoring the sources does not replay model calls or paused drafts');
});
