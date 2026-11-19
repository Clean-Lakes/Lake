import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {JsonRpcProcess} from './acp/process';
import {CodexAppServer} from './acp/codex-app-server';
import type {AgentActivity} from './acp/client';

const signal=()=>AbortSignal.timeout(5000);
const launch=(scenario='normal')=>({executable:process.execPath,args:[join(__dirname,'test-fixtures/codex-app-server-wire.cjs')],cwd:process.cwd(),env:{LAKE_WIRE_SCENARIO:scenario}});

test('process transport correlates out-of-order replies and discards late cancelled or timed-out replies',async t=>{
 const rpc=new JsonRpcProcess(launch());t.after(()=>rpc.close());
 const order:string[]=[];
 const slow=rpc.request<string>('fixture/slow',{},signal()).then(value=>order.push(value));
 const fast=rpc.request<string>('fixture/fast',{},signal()).then(value=>order.push(value));
 await Promise.all([slow,fast]);assert.deepEqual(order,['fast','slow']);
 await assert.rejects(rpc.request('fixture/slow',{},signal(),5),/超时/);
 const controller=new AbortController();const cancelled=rpc.request('fixture/slow',{},controller.signal);
 controller.abort(new Error('original request stopped'));await assert.rejects(cancelled,/original request stopped/);
 await delay(100);assert.equal(await rpc.request('fixture/fast',{},signal()),'fast');
});

for(const method of ['fixture/malformed','fixture/oversized'])test('process transport closes on '+method,async t=>{
 const rpc=new JsonRpcProcess(launch());t.after(()=>rpc.close());
 await assert.rejects(rpc.request(method,{},signal()),/无效或过大/);assert.equal(rpc.signal.aborted,true);
});

test('closing the owned process also terminates its descendants',{skip:process.platform==='win32'},async()=>{
 const rpc=new JsonRpcProcess(launch());
 const pid=await rpc.request<number>('fixture/descendant',{},signal());
 try{process.kill(pid,0);await rpc.close();await delay(50);assert.throws(()=>process.kill(pid,0));}
 finally{await rpc.close();try{process.kill(pid,'SIGKILL');}catch{/* Already stopped. */}}
});

for(const scenario of ['early','normal'])test('Codex routes exact thread/turn output and handles '+scenario+' completion without replay',async t=>{
 const activity:AgentActivity[]=[],adapter=new CodexAppServer(launch(scenario),event=>activity.push(event));t.after(()=>adapter.close());
 assert.equal((await adapter.initialize(signal())).runtime,'codex-app-server');
 const threadId=await adapter.openSession({cwd:process.cwd()},signal());assert.equal(threadId,'fixture-thread');
 const result=await adapter.exec('hello',signal());assert.equal(result.stopReason,'end_turn');
 await delay(20);
 assert.deepEqual(activity.filter(event=>event.kind==='text').map(event=>event.text),['你','你好']);
 assert.deepEqual(activity.flatMap(event=>event.kind==='tool'||event.kind==='tool_update'?[[event.kind,event.title,event.status]]:[]),[['tool','Read','running'],['tool_update','Read','completed']]);
 assert.deepEqual(activity.find(event=>event.kind==='usage'),{kind:'usage',usage:{inputTokens:10,outputTokens:5}});
 assert.ok(!JSON.stringify(activity).includes('WRONG'));assert.ok(!JSON.stringify(activity).includes('LATE_OUTPUT'));
});

test('Codex resumes one provider thread, excludes historical messages and subtracts historical token usage',async t=>{
 const activity:AgentActivity[]=[],adapter=new CodexAppServer(launch(),event=>activity.push(event));t.after(()=>adapter.close());
 await adapter.initialize(signal());await adapter.openSession({cwd:process.cwd(),threadId:'prior-thread'},signal());assert.equal(activity.length,0);
 assert.equal((await adapter.exec('resumed',signal())).stopReason,'end_turn');
 assert.ok(!JSON.stringify(activity).includes('DO_NOT_REPLAY'));
 assert.deepEqual(activity.find(event=>event.kind==='usage'),{kind:'usage',usage:{inputTokens:10,outputTokens:5}});
});

test('Codex refuses native approval and dynamic tool requests without forwarding business calls',async t=>{
 const adapter=new CodexAppServer(launch('approval'),()=>{});t.after(()=>adapter.close());
 await adapter.initialize(signal());await adapter.openSession({cwd:process.cwd()},signal());
 assert.equal((await adapter.exec('hello',signal())).stopReason,'end_turn');
});

for(const state of ['allowed','unmanaged','revoked'])test('MCP transport approval is current, observed, single use and '+state,async t=>{
 let guards=0;
 const gate=state==='unmanaged'?undefined:{server:'lake',tools:new Set(['Read']),guard:()=>{guards++;if(state==='revoked')throw new Error('original task revoked');}};
 const adapter=new CodexAppServer(launch('mcp-'+state),()=>{},gate);t.after(()=>adapter.close());
 await adapter.initialize(signal());await adapter.openSession({cwd:process.cwd()},signal());
 assert.equal((await adapter.exec('hello',signal())).stopReason,'end_turn');
 assert.equal(guards,state==='unmanaged'?0:1);
});

test('turn/start acknowledgement does not finish a turn; cancellation targets its confirmed identity',async t=>{
 const adapter=new CodexAppServer(launch('hold'),()=>{});t.after(()=>adapter.close());
 await adapter.initialize(signal());await adapter.openSession({cwd:process.cwd()},signal());
 let settled=false;const work=adapter.exec('hello',signal()).finally(()=>{settled=true;});
 await delay(50);assert.equal(settled,false);await adapter.cancel();assert.equal((await work).stopReason,'cancelled');
});

test('provider exit rejects the active turn instead of waiting for the final notification',async t=>{
 const adapter=new CodexAppServer(launch('exit'),()=>{});t.after(()=>adapter.close());
 await adapter.initialize(signal());await adapter.openSession({cwd:process.cwd()},signal());
 await assert.rejects(adapter.exec('hello',signal()),/进程已退出/);
});

test('an uncertain timed-out turn cannot be followed by another turn on the same connection',async t=>{
 const adapter=new CodexAppServer(launch('hold'),()=>{});t.after(()=>adapter.close());
 await adapter.initialize(signal());await adapter.openSession({cwd:process.cwd()},signal());
 const controller=new AbortController();
 const work=adapter.exec('hello',controller.signal);
 controller.abort(new Error('原任务期限已到'));
 await assert.rejects(work,/原任务期限已到/);
 await assert.rejects(adapter.exec('do not replay',signal()),/不可用/);
});

for(const scenario of ['steer-normal','steer-early','steer-ack-only','steer-rejected','steer-wrong-ack'])
test('Codex supplement consumption uses the exact current user-message identity: '+scenario,async t=>{
 const activity:AgentActivity[]=[],adapter=new CodexAppServer(launch(scenario),event=>activity.push(event));t.after(()=>adapter.close());
 await adapter.initialize(signal());await adapter.openSession({cwd:process.cwd()},signal());
 assert.equal(await adapter.steer('no active invocation','no-turn',signal()),false);
 const work=adapter.exec('original task',signal());await delay(30);
 if(scenario==='steer-wrong-ack')await assert.rejects(adapter.steer('new human context','input-1',signal()),/对应的补充轮次/);
 else assert.equal(await adapter.steer('new human context','input-1',signal()),scenario!=='steer-rejected');
 if(scenario==='steer-ack-only')assert.equal(activity.filter(event=>event.kind==='input').length,0,'RPC admission is not consumption');
 await delay(40);
 assert.deepEqual(activity.filter(event=>event.kind==='input'),['steer-normal','steer-early'].includes(scenario)?[{kind:'input',inputId:'input-1'}]:[]);
 await adapter.cancel();await work;
 assert.equal(await adapter.steer('after completion','late',signal()),false);
});
