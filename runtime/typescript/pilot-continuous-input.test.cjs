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
 const requests=[],taskIndexes=[];let firstClosed=false,finishedA=false;
 const provider=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  const admitted=[...body.messages].reverse().find(message=>message.role==='user'&&content(message).startsWith('[LAKE ADMITTED HUMAN EVENTS'));
  const lines=content(admitted).split('\n');
  const events=JSON.parse(lines[1]);requests.push(events);
  taskIndexes.push(JSON.parse(lines[lines.indexOf('[CURRENT TASK INDEX]')+1]));
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

 // Two historical direct tasks with identical titles must not compete with
 // the user's selected ID. Reading either record leaves its execution alone.
 const origin=app.store.list('superInputs').find(event=>event.messageId===a.id);
 const roleId='pilot:'+project.id;
 function historicalTask(taskId,status,summary,createdAt){
  const workerId='worker-'+taskId;
  app.store.put('superWorkers',workerId,{inline:true,id:workerId,taskId,sessionId:session,projectId:project.id,roleId,
    roleSnapshot:{id:roleId,projectId:project.id,roleKey:'pilot',name:'Pilot',duties:'测试任务',revision:1},
    createdAt,sourceEventId:origin.id,generation:1,state:'parked',inputEventIds:[origin.id],settledInputIds:[origin.id],policyHash:'fixture'});
  return app.superagent.ledger.create({id:taskId,sessionId:session,projectId:project.id,workerId,roleId,sourceEventId:origin.id,
    originRootTurnId:'history-'+taskId,title:'复测记录',status,summary,mode:'default',deadlineAt:new Date(Date.now()+60000).toISOString()});
 }
 const prior=historicalTask('older-finished','completed','旧任务结论','2026-10-01T00:00:00.000Z');
 const paused=historicalTask('newer-paused','paused','当前暂停进度','2026-10-02T00:00:00.000Z');
 const workspace=await api(`/api/projects/${project.id}/superagent`);
 assert.equal(workspace.workers.find(worker=>worker.task.taskId===prior.id).pilotSourceMessageId,a.id);
 for(const [target,text] of [[prior,'上次得出什么结论？'],[prior,'再解释一下。'],[paused,'上次暂停在哪一步？'],[null,'新话题。']]){
  const sent=await api(`/api/sessions/${session}/messages`,'POST',{text,...(target&&{taskId:target.id})},202);
  assert.deepEqual(sent.taskReference,target?{taskId:target.id,title:target.title}:undefined);
  const settled=await until(()=>api(`/api/sessions/${session}/snapshot`),view=>view.messages.some(message=>message.replyToMessageId===sent.id));
  assert.deepEqual(settled.messages.find(message=>message.id===sent.id).taskReference,sent.taskReference);
  assert.equal(requests.at(-1)[0].explicitTaskID,target?.id);
  if(target) assert.equal(taskIndexes.at(-1)[0].summary,target.summary);
 }
 for(const goal of [prior,paused]){
  assert.equal(app.superagent.ledger.get(goal.id).status,goal.status);
  assert.equal(app.superagent.ledger.get(goal.id).revision,goal.revision);
  assert.equal(app.store.get('superWorkers',goal.workerId).generation,1);
 }
 assert.equal(app.store.list('superGoals').length,2);
});
