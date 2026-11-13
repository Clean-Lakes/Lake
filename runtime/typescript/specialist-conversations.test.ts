import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LakeStore,HttpError} from './store';
import {SpecialistConversations,type ConversationRole} from './specialist-conversations';

async function fixture(t:{after(fn:()=>Promise<void>):void},count=3){
 const home=await mkdtemp(join(tmpdir(),'lake-conversation-')),store=await LakeStore.open(home,join(home,'data'));
 const project=store.createProject('shared dialogue'),pilot=store.createSession(project.id);
 store.put('superProjects',project.id,{projectId:project.id,routerSessionId:pilot.id,version:1});
 const roles:ConversationRole[]=Array.from({length:count},(_,i)=>({id:`role-${i}`,projectId:project.id,name:`干员${i+1}`,duties:'回应本人的讨论',revision:1}));
 for(const role of roles)store.put('superRoles',role.id,role);
 const requests:{sessionId:string;input:any}[]=[],aborts:string[]=[],notices:string[]=[];
 let clock=Date.now(),denied=false;
 const agents={redact:(v:string)=>v,publish(){},send:async(sessionId:string,_text:string,options:any)=>{requests.push({sessionId,input:JSON.parse(options.input)});},abort:async(sessionId:string)=>{aborts.push(sessionId);}};
 const ports={clock:()=>clock,check:()=>{if(denied)throw new HttpError(403,'denied');},channel:(role:ConversationRole)=>{
  const id='channel-'+role.id;if(!store.get('sessions',id))store.put('sessions',id,{...store.createSession(project.id),id});return id;
 },notify:(session:string)=>notices.push(session),schedule(){}};
 let host=new SpecialistConversations(store,agents as any,ports);
 const event={id:'human-event',projectId:project.id,sessionId:pilot.id,messageId:'human-message',payload:'全部干员给我报数！',disposition:'pending'};
 store.put('superInputs',event.id,event);
 const input={eventId:event.id,partKey:'roll-call',projectId:project.id,sessionId:pilot.id,sourceMessageId:event.messageId,quote:event.payload,instruction:'请每位干员亲自报数',roles,requestHash:'exact-request'};
 const start=()=>host.start(input);
 const admit=()=>{store.put('superInputs',event.id,{...event,disposition:'routed'});};
 const pump=()=>host.pump(4,()=>2);
 const settle=(sessionId:string,response?:string,error?:string)=>{store.put('views',sessionId,{...store.view(sessionId),status:error?'failed':'completed'});host.settled(sessionId,{response,error});};
 t.after(async()=>{await host.close();store.db.close();await rm(home,{recursive:true,force:true});});
 return {store,project,pilot,roles,event,input,requests,aborts,notices,get host(){return host;},start,admit,pump,settle,
  tick:(ms:number)=>{clock+=ms;},deny:()=>{denied=true;},restart:()=>{host=new SpecialistConversations(store,agents as any,ports);}};
}

test('a frozen invitation wakes independent speakers within shared capacity, delivers real replies and then asks Pilot to summarize',async t=>{
 const f=await fixture(t),round=f.start();
 await f.pump();assert.equal(f.requests.length,0,'pending routing cannot execute');
 f.admit();await f.pump();assert.equal(f.requests.length,2);assert.equal(f.host.running(),2);
 assert.notEqual(f.requests[0].sessionId,f.requests[1].sessionId);
 assert.equal(f.requests[0].input.self.roleId,f.roles[0].id);
 for(const request of f.requests){const profile=f.host.profile(request.sessionId)!;assert.deepEqual(profile.allowlist,[]);assert.deepEqual(profile.tools,[]);assert.equal(profile.subagents,false);await assert.rejects(profile.invoke!({} as any,{},{} as any),/没有资源执行权限/);}
 f.settle(round.members[1].sessionId,'2，干员2到！');await f.pump();assert.equal(f.requests.length,3);
 f.settle(round.members[0].sessionId,'1，干员1到！');await f.pump();assert.equal(f.requests.length,3,'summary waits for the last recipient');
 f.settle(round.members[2].sessionId,'3，干员3到！');await f.pump();
 const summary=f.requests.at(-1)!;assert.equal(summary.input.replied,3);assert.equal(summary.input.total,3);
 const replies=f.store.messages(f.pilot.id);assert.equal(replies.length,3);
 assert.deepEqual(new Set(replies.map(m=>m.author?.roleId)),new Set(f.roles.map(r=>r.id)));
 for(const message of replies){assert.equal(message.author?.taskId,undefined);assert.equal(message.author?.conversationId,round.id);assert.equal(message.conversation?.sourceMessageId,f.event.messageId);assert.equal(f.store.messages(message.author!.channelSessionId!).length,1);}
 f.settle(summary.sessionId,'全体 3 位干员已亲自回应，加上我共 4 位。');
 assert.equal(f.host.read(f.project.id,round.id).state,'completed');assert.equal(f.store.messages(f.pilot.id).at(-1)?.conversation?.kind,'summary');
 assert.equal(f.store.list('superGoals').length,0);assert.equal(f.store.list('superOperations').length,0);assert.equal(f.store.list('superAcceptance').length,0);
});

test('same event/part retries preserve membership and deliver each response once',async t=>{
 const f=await fixture(t,1),round=f.start();
 assert.deepEqual(f.start(),round);
 assert.throws(()=>f.host.start({...f.input,requestHash:'changed'}),/参数不能改变/);
 const later={...f.roles[0],id:'later',name:'later'};f.store.put('superRoles',later.id,later);
 assert.equal(f.host.start({...f.input,roles:[...f.roles,later]}).members.length,1);
 f.admit();await f.pump();f.settle(round.members[0].sessionId,'本人到！');f.settle(round.members[0].sessionId,'重复回应');
 assert.equal(f.store.messages(f.pilot.id).length,1);assert.equal(f.store.messages(f.pilot.id)[0].text,'本人到！');
});

test('empty responses, model failures and timeouts remain absent and the real summary receives their exact states',async t=>{
 const f=await fixture(t,4),round=f.start();f.admit();await f.pump();
 f.settle(round.members[0].sessionId,'');f.settle(round.members[1].sessionId,undefined,'provider rejected');await f.pump();
 f.settle(round.members[2].sessionId,'3，到！');
 f.tick(121000);await f.pump();
 const view=f.host.read(f.project.id,round.id);assert.deepEqual(view.members.map(m=>m.state),['failed','failed','replied','timed_out']);
 assert.ok(f.aborts.includes(round.members[3].sessionId));
 f.settle(round.members[3].sessionId,'迟到的伪成功');assert.equal(f.store.messages(f.pilot.id).length,1);
 const summary=f.requests.at(-1)!;assert.equal(summary.input.replied,1);assert.equal(summary.input.total,4);
 assert.deepEqual(summary.input.members.map((m:any)=>m.state),['failed','failed','replied','timed_out']);
});

test('stop fences queued speakers, live callbacks and the pending summary, keeping already received replies',async t=>{
 const f=await fixture(t),round=f.start();f.admit();await f.pump();f.settle(round.members[0].sessionId,'到！');
 await f.host.stop(f.project.id);f.settle(round.members[1].sessionId,'停止后的回复');await f.pump();
 assert.equal(f.host.read(f.project.id,round.id).state,'cancelled');assert.deepEqual(f.host.read(f.project.id,round.id).members.map(m=>m.state),['replied','cancelled','cancelled']);
 assert.equal(f.requests.length,2);assert.equal(f.store.messages(f.pilot.id).length,1);
});

test('restart retains actual receipts, marks missing speakers interrupted and never replays models',async t=>{
 const f=await fixture(t),round=f.start();f.admit();await f.pump();f.settle(round.members[0].sessionId,'已到！');
 f.restart();await f.pump();assert.equal(f.requests.length,2);
 assert.equal(f.host.read(f.project.id,round.id).state,'interrupted');assert.deepEqual(f.host.read(f.project.id,round.id).members.map(m=>m.state),['replied','interrupted','interrupted']);
 f.settle(round.members[1].sessionId,'旧进程迟到回复');assert.equal(f.store.messages(f.pilot.id).length,1);
});

test('current permission, role retirement and cross-project checks apply before model calls and reply commits',async t=>{
 const f=await fixture(t,2),round=f.start();f.admit();await f.pump();
 const profile=f.host.profile(round.members[0].sessionId)!;profile.beforeModel!();
 f.store.put('superRoles',f.roles[0].id,{...f.roles[0],deletedAt:new Date().toISOString()});assert.throws(()=>profile.beforeModel!(),/不可用/);
 f.settle(round.members[0].sessionId,'不能提交的回复');
 const foreign=f.store.createProject('foreign');assert.throws(()=>f.host.read(foreign.id,round.id),/当前项目/);
 f.deny();assert.throws(()=>f.host.profile(round.members[1].sessionId)!.beforeModel!(),/denied/);f.settle(round.members[1].sessionId,'无权提交');
 assert.equal(f.store.messages(f.pilot.id).length,0);await f.pump();assert.equal(f.host.read(f.project.id,round.id).state,'interrupted');
});

test('one specialist can be stopped without cancelling other recipients or creating business work',async t=>{
 const f=await fixture(t,2),round=f.start();f.admit();await f.pump();
 await f.host.stop(f.project.id,f.roles[0].id);f.settle(round.members[0].sessionId,'迟到');f.settle(round.members[1].sessionId,'2，到！');await f.pump();
 assert.equal(f.requests.at(-1)!.input.replied,1);assert.equal(f.requests.at(-1)!.input.members[0].state,'cancelled');
 assert.equal(f.store.list('superGoals').length,0);
});

test('queued recipients also time out and summary failure cannot fabricate a completed round',async t=>{
 const f=await fixture(t,2),round=f.start();f.admit();f.tick(121000);await f.pump();
 assert.equal(f.requests.length,1,'expired queued speakers never start a model');
 assert.equal(f.requests[0].input.replied,0);assert.ok(f.requests[0].input.members.every((member:any)=>member.state==='timed_out'));
 f.tick(121000);await f.host.expire();
 assert.equal(f.host.read(f.project.id,round.id).state,'failed');assert.match(f.store.messages(f.pilot.id).at(-1)!.text,/汇总等待超时/);
 f.settle(f.requests[0].sessionId,'迟到的全员到齐');assert.equal(f.host.read(f.project.id,round.id).state,'failed');
 assert.equal(f.store.messages(f.pilot.id).length,1);
});

test('an empty roster is summarized as empty and forged sources cannot create an invitation',async t=>{
 const f=await fixture(t,0);
 assert.throws(()=>f.host.start({...f.input,sourceMessageId:'forged'}),/准确人工来源/);
 const round=f.start();f.admit();await f.pump();assert.equal(f.requests[0].input.total,0);
 f.settle(f.requests[0].sessionId,'当前没有可召集的专员。');assert.equal(f.host.read(f.project.id,round.id).state,'completed');
});
