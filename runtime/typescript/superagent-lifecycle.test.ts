import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LakeStore } from "./store";
import { LakeSuperagent } from "./superagent";
import type { MessageInput } from "./message-input";
import { memoryContextUnavailable, memoryContextUnavailableNotice } from "./memory-errors";
import {digest} from "./tasks";
import {HttpError} from "./store";

// Exercise the actual host and SQLite ledger with a controlled SDK boundary.
// No model, credential, remote server or existing Dev data is accessed.
async function fixture(t: { after(fn: () => Promise<void>): void }, clock = Date.now) {
  const home = await mkdtemp(join(tmpdir(), "lake-dispatch-lifecycle-"));
  const store = await LakeStore.open(home, join(home, "data"));
  const requests: { sessionId: string; input: any }[] = [];
  let steering = 0;
  const agents = { executionView: (_sessionId:string,view:any)=>view, redact: (value: string) => value, publish() {}, prepareRedaction: async () => {}, isRunning: () => false,
    send: async (sessionId: string, _text: string, options: any) => { requests.push({ sessionId, input: JSON.parse(options.input) }); },
    steer: async () => { steering++; return true; }, abort: async () => {} };
  const host = new LakeSuperagent(store, agents as any, undefined, undefined, undefined, undefined, undefined, clock), internal = host as any;
  internal.schedule = () => {};
  t.after(async () => { await host.close(); store.db.close(); await rm(home, { recursive: true, force: true }); });
  const project = store.createProject("isolated lifecycle"), router = host.ensure(project.id).routerSessionId;
  store.put('providers','fixture-models',{id:'fixture-models',name:'Synthetic configured models',enabled:true,keyConfigured:true,protocol:'openai',baseURL:'http://127.0.0.1:9/v1',
    models:['model-a','model-b'].map(name=>({id:name,name,enabled:true,supportsImageInput:false,supportsImageOutput:false}))});
  const role = { id: "role-checker", projectId: project.id, roleKey: "checker", name: "项目检查员", duties: "检查当前项目", revision: 1, execution:{kind:'native' as const} };
  store.put("superRoles", role.id, role);
  const admit = async (value: string, selected?: MessageInput) => {
    const message = await host.send(router, value, undefined, false, selected) as { id: string };
    const event = store.list<any>("superInputs").find((item) => item.messageId === message.id)!;
    internal.batches.set(router, { eventIds: [event.id], complete: new Set([event.id]), input: JSON.stringify({ event: event.id }) });
    return event;
  };
  const route = (event: any, input: Record<string, unknown>) => internal.route(router, { event_id: event.id, part_key: "work", quote: event.payload,
    reason: "current human instruction", ...input });
  const settleRouter = (error?: string) => {
    const view = store.view(router); view.status = error ? "failed" : "completed"; store.put("views", router, view);
    internal.routerFinished(router, error);
  };
  const activate = async () => { await internal.pump(); };
  const worker = (taskId?: string) => store.list<any>("superWorkers").find((item) => !taskId || item.taskId === taskId)!;
  const read = async (taskId?: string, callId?: string) => {
    const current = worker(taskId), profile = host.profile(current.sessionId)!;
    const entry = profile.tools.find((item) => item.metadata.name === "list_project_files")!;
    return profile.invoke!(entry, {}, { toolCallId: callId ?? `files-${current.generation}`, abortSignal: new AbortController().signal } as any);
  };
  const finish = async (taskId?: string) => {
    const current = worker(taskId), entry = host.profile(current.sessionId)!.tools.find((item) => item.metadata.name === "work_finish")!;
    return entry.handler({ outcome: "completed", summary: "已读取本次项目文件列表。" }, { abortSignal: new AbortController().signal } as any) as Promise<any>;
  };
  const settleWorker = (taskId?: string) => {
    const current = worker(taskId), view = store.view(current.sessionId); view.status = "completed"; store.put("views", current.sessionId, view);
    internal.workerFinished(current.sessionId);
  };
  const start = async () => {
    const event = await admit("检查本项目的当前文件列表。");
    const handoff = route(event, { action: "create", title: "检查当前项目文件", role_id: role.id });
    settleRouter(); await activate(); await read(handoff.taskId);
    return { event, handoff, taskId: handoff.taskId };
  };
  return { store, host, internal, agents, project, router, role, requests, admit, route, settleRouter, activate, worker, read, finish, settleWorker, start,
    steering: () => steering };
}

test('specialist report Agent identity stays frozen and legacy projection never rewrites history or crosses bindings',async t=>{
 const f=await fixture(t),work=await f.start(),worker=f.worker(work.taskId);
 await f.finish(work.taskId);f.settleWorker(work.taskId);
 const report=f.store.messages(f.router).find(message=>message.author?.taskId===work.taskId)!;
 assert.ok(report?.author);assert.deepEqual(report.author.execution,worker.roleSnapshot.execution);
 const legacy=structuredClone(report);delete legacy.author!.execution;f.store.put('messages',legacy.id,legacy);
 const current=f.store.require<any>('superRoles',worker.roleId);current.execution={kind:'acp',agent:'codex'};current.revision++;f.store.put('superRoles',current.id,current);
 const before=JSON.stringify(f.store.messages(f.router));
 const shown=f.host.decorate(f.store.snapshot(f.router)).messages.find(message=>message.id===report.id)!;
 assert.deepEqual(shown.author!.execution,worker.roleSnapshot.execution);
 assert.equal(JSON.stringify(f.store.messages(f.router)),before,'reading history does not persist a migration');
 for(const field of ['roleId','workerId','sessionId','taskId']){
  const wrong=structuredClone(legacy);(wrong.author as any)[field]='unrelated';
  assert.equal(f.internal.reportMessage(wrong).author.execution,undefined,field);
 }
 const other=f.store.createProject('other project'),otherRouter=f.host.ensure(other.id).routerSessionId;
 assert.equal(f.internal.reportMessage({...legacy,sessionId:otherRouter}).author.execution,undefined);
});

test('Pilot shared dialogue runs independent replies and an explicitly requested Pilot synthesis without business goals',async t=>{
  const f=await fixture(t),event=await f.admit('全部干员亲自回应，最后由 Pilot 综合意见。');
  const invite=f.host.profile(f.router)!.tools.find(entry=>entry.metadata.name==='convene_specialists')!;
  const input={event_id:event.id,part_key:'attendance',quote:event.payload,instruction:'请每位干员亲自回应',audience:'all',summarize:true};
  const round:any=await invite.handler(input,{} as any);
  assert.equal(round.members.length,1);assert.equal(round.members[0].roleId,f.role.id);
  assert.equal((await invite.handler(input,{} as any) as any).id,round.id);
  assert.equal(f.requests.length,0);
  f.settleRouter();await f.activate();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].sessionId,round.members[0].sessionId);
  assert.equal(f.host.profile(round.members[0].sessionId)!.systemPrompt.includes(f.role.name),true);
  f.store.put('views',round.members[0].sessionId,{...f.store.view(round.members[0].sessionId),status:'completed'});
  f.host.settled(round.members[0].sessionId,{response:'1，项目检查员到！'});await f.activate();
  const summary=f.requests.at(-1)!;assert.equal(summary.input.replied,1);
  f.store.put('views',summary.sessionId,{...f.store.view(summary.sessionId),status:'completed'});
  f.host.settled(summary.sessionId,{response:'1 位干员已回应。'});
  assert.equal(f.host.workspace(f.project.id).conversations![0].state,'completed');
  assert.equal(f.store.messages(f.router).at(-2)?.author?.roleId,f.role.id);
  assert.equal(f.store.messages(f.router).at(-1)?.conversation?.kind,'summary');
  assert.equal(f.store.list('superGoals').length,0);assert.equal(f.store.list('superOperations').length,0);
  assert.ok(f.store.catalog().sessions.every(session=>session.workspaceRole!=='conversation'));
  await assert.rejects(f.host.send(round.members[0].sessionId,'伪造来源'),/请在 Pilot/);
});

test('Pilot stop cancels dialogue speakers and prevents a late response or summary',async t=>{
  const f=await fixture(t),event=await f.admit('全部干员报数！');
  const invite=f.host.profile(f.router)!.tools.find(entry=>entry.metadata.name==='convene_specialists')!;
  const round:any=await invite.handler({event_id:event.id,part_key:'attendance',quote:event.payload,instruction:'报数',audience:'all'},{} as any);
  f.settleRouter();await f.activate();await f.host.stopWorkspace(f.project.id,f.router);
  f.store.put('views',round.members[0].sessionId,{...f.store.view(round.members[0].sessionId),status:'completed'});
  f.host.settled(round.members[0].sessionId,{response:'迟到的报到'});await f.activate();
  assert.equal(f.host.workspace(f.project.id).conversations![0].state,'cancelled');
  assert.equal(f.store.messages(f.router).filter(message=>message.conversation).length,0);
});

test("only current unfinished business work requests a final report, without changing acceptance", async t => {
  const f = await fixture(t), { taskId } = await f.start(), worker = f.worker(taskId), profile = f.host.profile(worker.sessionId)!;
  const goal = JSON.stringify(f.host.ledger.get(taskId)), operations = JSON.stringify(f.store.list("superOperations"));
  assert.equal(profile.requestFinalReport!(), true);
  assert.equal(JSON.stringify(f.host.ledger.get(taskId)), goal);
  assert.equal(JSON.stringify(f.store.list("superOperations")), operations);
  await f.finish(taskId);
  assert.equal(profile.requestFinalReport!(), false);
  assert.equal(f.host.ledger.get(taskId).acceptanceState, "not_evaluated");
});

test('specialist creation persists a random available model, replays once and preserves frozen Workers on later edits',async t=>{
 const f=await fixture(t),event=await f.admit('创建一个巡检专员，负责检查项目。');
 const input={event_id:event.id,part_key:'create',action:'create',role_key:'new-checker',name:'巡检专员',duties:'检查项目',quote:event.payload};
 const saved=f.internal.manage(f.router,input),binding=saved.execution;
 assert.equal(binding.kind,'native');assert.equal(binding.model.providerId,'fixture-models');assert.ok(['model-a','model-b'].includes(binding.model.modelId));
 const provider=f.store.modelProvider('fixture-models')!;provider.enabled=false;f.store.put('providers',provider.id,provider);
 assert.deepEqual(f.internal.manage(f.router,input),saved,'the same creation returns its receipt even if the available pool changes');
 assert.equal(f.store.list('superRoleMutations').length,1);
 const reopened=await LakeStore.open(f.store.home,f.store.data);try{assert.deepEqual(reopened.require<any>('superRoles',saved.id).execution,binding);}finally{reopened.db.close();}
 provider.enabled=true;f.store.put('providers',provider.id,provider);
 const taskEvent=await f.admit('让巡检专员检查项目。'),task=f.route(taskEvent,{action:'create',title:'检查项目',role_id:saved.id});f.settleRouter();
 const worker=f.worker(task.taskId),before=JSON.stringify(worker.roleSnapshot);
 const appearance=await f.admit('把巡检专员头像改为河狸。');
 const changed=f.internal.manage(f.router,{event_id:appearance.id,part_key:'avatar',action:'update',role_id:saved.id,expected_revision:1,avatar_id:'beaver',quote:appearance.payload});
 assert.deepEqual(changed.execution,binding);assert.equal(JSON.stringify(f.worker(task.taskId).roleSnapshot),before);
 const same=f.host.setRoleExecution(f.project.id,saved.id,{expectedRevision:2,execution:{kind:'native'}});assert.deepEqual(same.execution,binding);
 const other=binding.model.modelId==='model-a'?'model-b':'model-a',modelEvent=await f.admit('以后巡检专员使用 '+other+'。');
 const updated=f.internal.manage(f.router,{event_id:modelEvent.id,part_key:'model',action:'update',role_id:saved.id,expected_revision:3,model_id:other,quote:modelEvent.payload});
 assert.equal(updated.execution.model.modelId,other);assert.equal(JSON.stringify(f.worker(task.taskId).roleSnapshot),before);
 assert.equal(f.store.modelSelection(),undefined,'role configuration never changes Pilot selection');
});

test('model-only specialist creation keeps the requested model and freezes its compatible Codex Agent',async t=>{
 const f=await fixture(t),profile={id:'codex',projectId:f.project.id,revision:7,enabled:true};
 (f.agents as any).external={registry:{get:()=>profile}};
 f.store.put('acpProbes',f.project.id+':codex',{revision:7,authentication:'codex-local',ready:true,authenticated:true,model:'gpt-6.1-sol'});
 const event=await f.admit('创建专员，使用 gpt-6.1-sol。');
 const saved=f.internal.manage(f.router,{event_id:event.id,part_key:'create',action:'create',role_key:'sol-checker',name:'Sol 检查员',duties:'检查项目',model_id:'gpt-6.1-sol',quote:event.payload});
 assert.deepEqual(saved.execution,{kind:'acp',agent:'codex',model:{modelId:'gpt-6.1-sol'}});
 const work=await f.admit('检查项目。'),task=f.route(work,{action:'create',title:'检查项目',role_id:saved.id});
 assert.deepEqual(f.worker(task.taskId).roleSnapshot.execution,{...saved.execution,revision:7});
 assert.deepEqual(f.internal.listRoles(f.project.id).items.find((role:any)=>role.id===saved.id).execution,saved.execution);
});

test('implicit specialist creation saves its default once and an empty model pool cannot create a role',async t=>{
 const f=await fixture(t),event=await f.admit('创建一个新专员检查项目。');
 const input={action:'create',title:'检查项目',role_key:'implicit-checker'},task=f.route(event,input),role=f.store.require<any>('superRoles',task.roleId);
 assert.ok(role.execution.model);assert.deepEqual(f.worker(task.taskId).roleSnapshot.execution,role.execution);
 const replay=f.route(event,input);assert.equal(replay.taskId,task.taskId);assert.equal(replay.roleId,task.roleId);
 assert.deepEqual(f.store.require<any>('superRoles',role.id).execution,role.execution);assert.equal(f.store.list('superWorkers').length,1);
 f.settleRouter();for(const provider of f.store.modelProviders())f.store.delete('providers',provider.id);
 const next=await f.admit('创建另一个专员。'),before=JSON.stringify([f.store.list('superRoles'),f.store.list('superChannels'),f.store.list('superRoleMutations')]);
 assert.throws(()=>f.internal.manage(f.router,{event_id:next.id,part_key:'create',action:'create',role_key:'unavailable',name:'新专员',duties:'',quote:next.payload}),/没有符合要求/);
 assert.equal(JSON.stringify([f.store.list('superRoles'),f.store.list('superChannels'),f.store.list('superRoleMutations')]),before);
});

test('Pilot partially updates appearance and future defaults without changing existing task snapshots',async t=>{
 const f=await fixture(t),source=await f.admit('检查本项目文件。');
 const handoff=f.route(source,{action:'create',title:'原检查任务',role_id:f.role.id});f.settleRouter();
 const before=JSON.stringify(f.store.list('superWorkers')),goals=JSON.stringify(f.store.list('superGoals'));
 const channel=f.host.workspace(f.project.id).channels![0];
 const event=await f.admit('把项目检查员的头像改成河狸。');
 const change={event_id:event.id,part_key:'appearance',action:'update',role_id:f.role.id,expected_revision:1,avatar_id:'beaver',quote:event.payload};
 const saved=f.internal.manage(f.router,change);
 assert.equal(saved.name,f.role.name);assert.equal(saved.duties,f.role.duties);assert.deepEqual(saved.execution,{kind:'native'});
 assert.equal(saved.avatarId,'beaver');assert.equal(saved.revision,2);
 assert.deepEqual(f.internal.manage(f.router,change),saved,'exact decision replay does not increment the role');
 assert.throws(()=>f.internal.manage(f.router,{...change,avatar_id:'fox'}),/decision conflict/);
 const updated=f.host.workspace(f.project.id).channels![0];
 assert.equal(updated.sessionId,channel.sessionId);assert.equal(updated.roleId,channel.roleId);assert.equal(updated.avatarId,'beaver');
 assert.equal(JSON.stringify(f.store.list('superWorkers')),before);assert.equal(JSON.stringify(f.store.list('superGoals')),goals);
 assert.equal(f.worker(handoff.taskId).roleSnapshot.avatarId,undefined);
 (f.agents as any).external={registry:{get:()=>({id:'codex',projectId:f.project.id,revision:7,enabled:true})}};
 const defaults=await f.admit('更名为复核专员，职责改为核实证据，以后默认用 Codex。');
 const configured=f.internal.manage(f.router,{event_id:defaults.id,part_key:'defaults',action:'update',role_id:f.role.id,expected_revision:2,name:'复核专员',duties:'核实证据',execution:{kind:'acp',agent:'codex'},quote:defaults.payload});
 assert.equal(configured.avatarId,'beaver');assert.equal(configured.name,'复核专员');assert.equal(configured.duties,'核实证据');
 assert.deepEqual(configured.execution,{kind:'acp',agent:'codex'});
 assert.equal(f.store.session(channel.sessionId).title,'复核专员');
 assert.equal(JSON.stringify(f.store.list('superWorkers')),before);assert.equal(JSON.stringify(f.store.list('superGoals')),goals);
 assert.deepEqual(f.worker(handoff.taskId).roleSnapshot.execution,{kind:'native'});
 const reset=await f.admit('恢复默认头像。');
 f.internal.manage(f.router,{event_id:reset.id,part_key:'reset',action:'update',role_id:f.role.id,expected_revision:3,avatar_id:'auto',quote:reset.payload});
 assert.equal(Object.hasOwn(f.store.require<any>('superRoles',f.role.id),'avatarId'),false);
 assert.equal(f.store.require<any>('superRoles',f.role.id).name,'复核专员');
 const api=f.host.setRoleExecution(f.project.id,f.role.id,{expectedRevision:4,execution:{kind:'acp',agent:'codex',revision:7}});
 assert.deepEqual(api.execution,{kind:'acp',agent:'codex'},'the existing API accepts a profile revision without persisting a task binding');
});

test('specialist configuration rejects stale, foreign, unsupported and unadmitted edits atomically',async t=>{
 const f=await fixture(t),event=await f.admit('调整项目检查员的配置。');
 const base={event_id:event.id,part_key:'edit',action:'update',role_id:f.role.id,expected_revision:1,avatar_id:'beaver',quote:event.payload};
 const before=JSON.stringify(f.store.require('superRoles',f.role.id));
 const reject=(patch:Record<string,unknown>)=>{
  assert.throws(()=>f.internal.manage(f.router,{...base,...patch}));
  assert.equal(JSON.stringify(f.store.require('superRoles',f.role.id)),before);
  assert.deepEqual(f.store.list('superRoleMutations'),[]);
 };
 reject({expected_revision:0});reject({avatar_id:'https://invalid.example/avatar.svg'});reject({avatar_id:null});
 reject({duties:42});reject({name:''});reject({permissions:{silentCommands:true}});
 reject({execution:{kind:'acp',agent:'claude'}});reject({execution:{kind:'native',agent:'codex'}});
 reject({execution:{kind:'native',extra:true}});reject({quote:'not admitted'});reject({event_id:'missing-event'});
 const foreign=f.store.createProject('other project');
 f.store.put('superRoles','foreign-role',{...f.role,id:'foreign-role',projectId:foreign.id});
 reject({role_id:'foreign-role'});
 assert.throws(()=>f.internal.manage(f.router,{event_id:event.id,part_key:'create',action:'create',role_key:'incomplete',avatar_id:'beaver',quote:event.payload}),/name and duties/);
 assert.equal(f.store.list<any>('superRoles').length,2);
});

test('the shared avatar catalog is discoverable by Chinese name, alias and exact ID only as metadata',async t=>{
 const f=await fixture(t),entry=f.internal.routerEntries(f.router).find((item:any)=>item.metadata.name==='list_specialist_avatars');
 assert.ok(entry);assert.equal(entry.metadata.readOnly,true);
 const lookup=async(query?:string)=>entry.handler(query===undefined?{}:{query},{});
 assert.equal((await lookup()).items.length,100);
 for(const query of ['河狸','海狸','🦫','BEAVER'])assert.deepEqual((await lookup(query)).items.map((item:any)=>item.id),['beaver']);
 assert.deepEqual((await lookup('https://invalid.example')).items,[]);
 assert.equal((await lookup('河狸')).reset,'auto');
 const event=await f.admit('创建牛马专员，头像河狸，负责核实证据。');
 const saved=f.internal.manage(f.router,{event_id:event.id,part_key:'create',action:'create',role_key:'beaver-reviewer',name:'牛马专员',duties:'核实证据',avatar_id:'beaver',execution:{kind:'native'},quote:event.payload});
 assert.equal(saved.avatarId,'beaver');assert.equal(saved.revision,1);
 assert.equal(f.host.workspace(f.project.id).channels!.find(item=>item.roleId===saved.id)?.avatarId,'beaver');
 const appearance=await f.admit('创建一个只有名称和河狸头像的专员，不指定职责。');
 const empty=f.internal.manage(f.router,{event_id:appearance.id,part_key:'appearance-only',action:'create',role_key:'appearance-only',name:'河狸伙伴',duties:'',avatar_id:'beaver',execution:{kind:'native'},quote:appearance.payload});
 assert.equal(empty.duties,'');assert.equal(empty.avatarId,'beaver');
 assert.deepEqual(f.store.list('superWorkers'),[]);assert.deepEqual(f.store.list('superGoals'),[]);
});

test('Pilot delegation reports a missing local Codex login after a successful connection without creating a task',async t=>{
  const f=await fixture(t);
  (f.agents as any).external={registry:{get:()=>({id:'codex',projectId:f.project.id,revision:1,enabled:true})}};
  f.store.put('superRoles',f.role.id,{...f.role,execution:{kind:'acp',agent:'codex'}});
  f.store.put('acpProbes',f.project.id+':codex',{revision:1,ready:true,authentication:'codex-local',authenticated:false});
  const event=await f.admit('检查当前服务器状态');
  assert.throws(()=>f.route(event,{action:'create',role_id:f.role.id,title:'检查服务器'}),/本机 Codex 尚未登录/);
  assert.equal(f.store.list('superWorkers').length,0);
  assert.equal(f.store.list('superGoals').length,0);
});

test("old generations, explicit plans and a stopped worker cannot start report repair", async t => {
  const f = await fixture(t), { taskId } = await f.start(), worker = f.worker(taskId), profile = f.host.profile(worker.sessionId)!;
  const operation = f.store.list<any>("superOperations")[0];
  operation.generation--; f.store.put("superOperations", operation.id, operation);
  assert.equal(profile.requestFinalReport!(), false);
  operation.generation++; f.store.put("superOperations", operation.id, operation);
  const goal = f.host.ledger.get(taskId); goal.executionMode = "explicit_plan"; f.host.ledger.save(goal);
  assert.equal(profile.requestFinalReport!(), false);
  goal.executionMode = "host_managed"; f.host.ledger.save(goal);
  worker.state = "stopped"; f.store.put("superWorkers", worker.id, worker);
  assert.equal(profile.requestFinalReport!(), false);
  assert.equal(f.store.list("superReportRepairs").length, 0);
});

test("pending human steering defers a partial submission instead of starting report repair", async t => {
  const f = await fixture(t), { taskId } = await f.start(), worker = f.worker(taskId), profile = f.host.profile(worker.sessionId)!;
  const next = await f.admit("还要说明缺失的平台事件。");
  f.route(next, { action: "followup", task_id: taskId, role_id: f.role.id });
  assert.equal(profile.requestFinalReport!(), false);
  const finish = profile.tools.find(entry => entry.metadata.name === "work_finish")!;
  await finish.handler({ summary: "现有发现已保留，仍缺平台事件。", outcome: "partial" }, {} as any);
  assert.equal(profile.requestFinalReport!(), false);
  assert.equal(f.store.list("superReportRepairs").length, 0);
  assert.notEqual(f.host.ledger.get(taskId).acceptanceState, "pass");
});

test("an ordinary partial report is delivered without requesting another model step", async t => {
  const f = await fixture(t), { taskId } = await f.start(), worker = f.worker(taskId), profile = f.host.profile(worker.sessionId)!;
  const finish = profile.tools.find(entry => entry.metadata.name === "work_finish")!;
  await finish.handler({ summary: "已读取记录，尚缺平台事件。", outcome: "partial" }, {} as any);
  assert.equal(profile.requestFinalReport!(), false);
  assert.equal(f.store.list("superReportRepairs").length, 0);
  assert.equal(f.host.ledger.get(taskId).status, "completed");
  assert.notEqual(f.host.ledger.get(taskId).acceptanceState, "pass");
});

test("recorded tool output is paged without local execution or new evidence, with exact task/generation/child ownership",async t=>{
  const f=await fixture(t),{taskId}=await f.start(),worker=f.worker(taskId),profile=f.host.profile(worker.sessionId)!;
  const tool=profile.tools.find(entry=>entry.metadata.name==="read_tool_output")!;
  const op=f.store.list<any>("superOperations")[0],output={stdout:"CURRENT_OUTPUT "+"中".repeat(16000)+" END_OF_RECEIPT"};
  op.output=output;op.outputHash=digest(output);f.store.put("superOperations",op.id,op);
  const before=JSON.stringify(f.store.list("superOperations")),goalBefore=JSON.stringify(f.host.ledger.get(taskId));
  const read=(input:any,child?:any)=>profile.invoke!(tool,input,{toolCallId:"read-page",abortSignal:new AbortController().signal,...(child?{lakeSubagent:child}:{})} as any);
  let content="",offset=0;do{const page:any=await read({tool_call_id:op.callId,offset,limit:8192});content+=page.content;offset=page.nextOffset;}while(offset!==undefined);
  assert.match(content,/END_OF_RECEIPT/);assert.deepEqual(JSON.parse(content),output);
  assert.equal(JSON.stringify(f.store.list("superOperations")),before);assert.equal(JSON.stringify(f.host.ledger.get(taskId)),goalBefore);
  for(const fields of [{goalId:"other"},{projectId:"other"},{sessionId:"other"},{generation:worker.generation+1},{policyHash:"other"},{agentRunId:"child",childSessionId:"child-session"}]){
    f.store.put("superOperations",op.id,{...op,...fields});await assert.rejects(read({tool_call_id:op.callId}),/没有这笔工具回执/);
  }
  f.store.put("superOperations",op.id,{...op,agentRunId:"child",childSessionId:"child-session",originalCallId:"child-original"});
  const page:any=await read({tool_call_id:"child-original"},{id:"child",sessionId:"child-session",toolCallId:"new-read"});assert.match(page.content,/CURRENT_OUTPUT/);
  await assert.rejects(read({tool_call_id:"child-original"},{id:"other-child",sessionId:"child-session"}),/没有这笔工具回执/);
  f.store.put("superOperations",op.id,{...op,output:{stdout:"tampered"}});await assert.rejects(read({tool_call_id:op.callId}),/校验失败/);
  f.store.put("superOperations",op.id,{...op,status:"dispatched"});await assert.rejects(read({tool_call_id:op.callId}),/仍在执行/);
  f.store.put("superOperations",op.id,op);
  await assert.rejects(read({tool_call_id:op.callId,limit:8193}),/分页范围/);
  (f.host.ledger as any).revalidate=()=>{throw new HttpError(403,"current source permission revoked");};
  await assert.rejects(read({tool_call_id:op.callId}),/permission revoked/);
});

test("Bash host preflight returns recoverable validation failure while the permission and dispatch guards remain enforced",async t=>{
  const f=await fixture(t),{taskId}=await f.start(),worker=f.worker(taskId);
  let dispatched=0;const native:any={metadata:{name:"Bash",description:"shell"},inputSchema:{properties:{}},validateInput:()=>({result:true}),handler:()=>{dispatched++;}};
  f.internal.execution={plan:()=>{throw new HttpError(403,"原项目策略不允许此命令资源");}};
  const entry=f.internal.configureBash(worker,native),input={command:"python3 -I -c 'print(1)'"};
  assert.deepEqual(entry.validateInput(input,{}),{result:false,errorCode:403,message:"原项目策略不允许此命令资源"});
  assert.throws(()=>entry.resolvePermissionCapability(input),/原项目策略/);
  await assert.rejects(f.internal.invokeBash(worker,entry,input,{}),/原项目策略/);assert.equal(dispatched,0);
  native.validateInput=()=>({result:false,errorCode:42,message:"native schema failure"});
  assert.equal(f.internal.configureBash(worker,native).validateInput(input,{}).errorCode,42);
  native.validateInput=()=>({result:true});
  const local=f.store.catalog().resources.find(r=>r.projectId===worker.projectId&&r.kind==="local")!;
  f.internal.execution={plan:()=>({resource:local,readOnly:false})};
  const goal=f.host.ledger.get(taskId);goal.readOnlyRecoveryOf="original-with-unknown";f.store.put("superGoals",taskId,goal);
  assert.match(f.internal.configureBash(worker,native).validateInput(input,{}).message,/仅允许独立只读检查/);
  const report=f.internal.reportPresentation(f.host.ledger.get(taskId),undefined,"原项目策略不允许此命令资源");
  assert.match(report.body,/策略未允许的资源/);assert.doesNotMatch(report.body,/需要.*提供.*权限/);
});

test("ordinary inline Pilot profiles use host-managed tools while explicit plans keep their original protocol", async (t) => {
  const f = await fixture(t); await f.admit("请 Pilot 亲自执行检查。");
  const names = (profile: any) => profile.tools.map((entry: any) => entry.metadata.name);
  const finishSchema = (profile: any) => profile.tools.find((entry: any) => entry.metadata.name === "work_finish").inputSchema;
  let profile = f.host.profile(f.router)!;
  assert.ok(!names(profile).includes("work_begin")); assert.ok(!names(profile).includes("work_update"));
  assert.ok(JSON.stringify(finishSchema(profile)).includes('"outcome"'));
  assert.ok(profile.subagents); assert.ok(profile.allowlist.includes("Bash"));
  // The unmaterialized Pilot task must honor Plan mode as well.
  const session = f.store.session(f.router); session.options.conversationMode = "plan"; f.store.put("sessions", f.router, session);
  profile = f.host.profile(f.router)!;
  assert.ok(names(profile).includes("work_begin")); assert.ok(names(profile).includes("work_update"));
  assert.ok(JSON.stringify(finishSchema(profile)).includes('"outcome"'));
  // Existing explicit contracts win over a later conversation-mode change.
  const actor = f.internal.pilotActors.get(f.router);
  f.host.ledger.create({ id: actor.taskId, projectId: f.project.id, sessionId: f.router, workerId: actor.id, roleId: actor.roleId,
    sourceEventId: actor.sourceEventId, originRootTurnId: "root", title: "原计划", userText: "原计划", status: "running",
    deadlineAt: new Date(Date.now() + 60000).toISOString(), mode: "default", executionMode: "explicit_plan" });
  session.options.conversationMode = "default"; f.store.put("sessions", f.router, session);
  profile = f.host.profile(f.router)!;
  assert.ok(names(profile).includes("work_begin")); assert.ok(names(profile).includes("work_update"));
  assert.ok(JSON.stringify(finishSchema(profile)).includes('"outcome"'));
});

for(const entrance of ["followup","predecessor","predecessor-current-memory"]) test(`invalid-memory ${entrance} creates one bounded read-only recheck without changing its source`, async t => {
  const f = await fixture(t), resource = f.store.catalog().resources.find(r => r.projectId === f.project.id)!;
  const event = await f.admit("检查本机重启记录。", {resourceIds:[resource.id],mentions:[],references:[]});
  const original = f.route(event,{action:"create",title:"重启检查",role_id:f.role.id});
  f.settleRouter(); await f.activate();
  const oldWorker = f.worker(original.taskId); oldWorker.state="parked"; f.store.put("superWorkers",oldWorker.id,oldWorker);
  const source = f.host.ledger.get(original.taskId); source.status="blocked"; source.summary=memoryContextUnavailable; f.host.ledger.save(source);
  const unknown={id:"unresolved-source",goalId:source.id,sessionId:source.sessionId,projectId:f.project.id,status:"unknown",readOnly:false};
  f.store.put("superOperations",unknown.id,unknown);
  (f.agents as any).memory={captureUser(){},captureTask(){},needsFreshContext:(actor:any)=>entrance!=="predecessor-current-memory"&&actor.sessionId===source.sessionId,projectTaskContext:(items:any)=>items};
  const before={goal:f.host.ledger.get(source.id),worker:f.worker(source.id),operations:f.store.list("superOperations")};
  const human = await f.admit("再查一下"), input=entrance==="followup"?{action:"followup",task_id:source.id,role_id:f.role.id}
    :{action:"create",predecessor_task_id:source.id,title:"继续排查重启",role_id:f.role.id};
  const result = f.route(human,input);
  assert.notEqual(result.taskId,source.id); assert.equal(result.recoveryOfTaskId,source.id); assert.equal(result.action,"create");
  assert.equal(f.route(human,input).taskId,result.taskId);
  assert.equal(f.route(human,{...input,part_key:"another"}).taskId,result.taskId);
  const fresh = f.host.ledger.get(result.taskId);
  assert.equal(fresh.readOnlyRecoveryOf,source.id); assert.equal(fresh.deadlineAt,source.deadlineAt);
  assert.notEqual(fresh.sessionId,source.sessionId); assert.equal(fresh.roleId,source.roleId);
  assert.deepEqual(f.worker(fresh.id).targetResourceIds,[resource.id]); assert.equal(f.store.list("superReferences").length,0);
  if(entrance==="followup") {
    const snapshot=f.host.ledger.get(fresh.id),invocation=f.worker(fresh.id);
    const changedEntrance=f.route(human,{action:"create",predecessor_task_id:source.id,title:"继续排查",role_id:f.role.id,part_key:"different-entrance"});
    assert.equal(changedEntrance.taskId,fresh.id);assert.deepEqual(f.host.ledger.get(fresh.id),snapshot);assert.deepEqual(f.worker(fresh.id),invocation);
  }
  f.settleRouter(); await f.activate();
  const envelope=f.requests.at(-1)!.input;
  assert.equal(envelope.originalRequirement,human.payload); assert.equal(envelope.readOnlyRecheck.originalHumanRequirement,event.payload);
  assert.deepEqual(envelope.taskContext.items,[]); assert.equal(envelope.predecessor,undefined);
  assert.deepEqual(f.internal.recallContext(f.worker(fresh.id),{task_id:source.id},true).items,[]);
  assert.ok(!JSON.stringify(envelope).includes(memoryContextUnavailable));
  await f.read(fresh.id); await f.finish(fresh.id); f.settleWorker(fresh.id);
  assert.equal(f.host.ledger.get(fresh.id).acceptanceState,"not_evaluated");
  assert.deepEqual(f.host.ledger.get(source.id),before.goal); assert.deepEqual(f.worker(source.id),before.worker);
  assert.deepEqual(f.store.list<any>("superOperations").filter(op=>op.goalId===source.id),before.operations);
  assert.equal(f.host.ledger.unresolved(source.id),true);
  assert.equal(f.internal.reportPresentation(before.goal,undefined,memoryContextUnavailable).body,memoryContextUnavailableNotice);
});

for (const entrance of ["followup","predecessor"]) for (const variant of ["scope", "plan", "expired", "active", "joint", "role"]) test(`invalid-memory ${entrance} recheck keeps ${variant} restrictions`, async t=>{
  const f=await fixture(t),resource=f.store.catalog().resources.find(r=>r.projectId===f.project.id)!;
  const event=await f.admit("检查主机。",variant==="scope"?undefined:{resourceIds:[resource.id],mentions:[],references:[]});
  const result=f.route(event,{action:"create",title:"检查主机",role_id:f.role.id});f.settleRouter();await f.activate();
  const worker=f.worker(result.taskId);worker.state=variant==="active"?"active":"parked";f.store.put("superWorkers",worker.id,worker);
  const goal=f.host.ledger.get(result.taskId);goal.status="blocked";
  if(variant==="plan")goal.executionMode="explicit_plan";
  if(variant==="expired")goal.deadlineAt=new Date(Date.now()-1).toISOString();
  if(variant==="joint")goal.sharedTaskId=goal.id;
  f.host.ledger.save(goal);
  (f.agents as any).memory={captureUser(){},captureTask(){},needsFreshContext:()=>true};
  const human=await f.admit("继续");
  const before=f.store.list("superGoals");
  const input=entrance==="followup"?{action:"followup",task_id:goal.id}:{action:"create",predecessor_task_id:goal.id,title:"再次检查",role_id:f.role.id};
  assert.throws(()=>f.route(human,{...input,...(variant==="role"?{role_id:"wrong-role"}:{})}));
  assert.deepEqual(f.store.list("superGoals"),before);
});

test("an unfinished predecessor cannot expand resources, import old evidence or create joint recovery",async t=>{
  const f=await fixture(t),resource=f.store.catalog().resources.find(r=>r.projectId===f.project.id)!;
  const original=await f.admit("检查本机",{resourceIds:[resource.id],mentions:[],references:[]});
  const first=f.route(original,{action:"create",title:"检查本机",role_id:f.role.id});f.settleRouter();await f.activate();
  const worker=f.worker(first.taskId);worker.state="parked";f.store.put("superWorkers",worker.id,worker);
  const goal=f.host.ledger.get(first.taskId);goal.status="blocked";f.host.ledger.save(goal);
  const other={...resource,id:"outside-original-scope"};f.store.put("resources",other.id,other);
  const otherRole={...f.role,id:"another-specialist",roleKey:"another"};f.store.put("superRoles",otherRole.id,otherRole);
  const human=await f.admit("再次检查",{resourceIds:[other.id],mentions:[],references:[]});
  const input={action:"create",predecessor_task_id:goal.id,title:"复查",role_id:f.role.id};
  const before=f.store.list("superGoals");
  assert.throws(()=>f.route(human,{...input,resource_ids:[other.id]}),/扩大范围/);
  assert.throws(()=>f.route(human,{...input,evidence_task_ids:[goal.id]}),/不导入旧执行证据/);
  const {role_id:_,...joint}=input;
  assert.throws(()=>f.route(human,{...joint,role_ids:[f.role.id,otherRole.id]}),/共同任务/);
  assert.deepEqual(f.store.list("superGoals"),before);assert.equal(f.store.list("superReferences").length,0);
});

test("completed fresh checks preserve old acceptance, carry target context and use new current receipts", async (t) => {
  const f = await fixture(t), original = await f.start();
  assert.equal(original.handoff.handoff.recorded, true);
  assert.equal(original.handoff.dispatch.state, "queued");
  assert.equal(original.handoff.handoff.observedAt, original.handoff.dispatch.observedAt);
  await f.finish(); f.settleWorker();
  const source = f.host.ledger.get(original.taskId), oldReceipts = f.store.list("superAcceptance"), oldOperations = f.store.list("superOperations");
  const event = await f.admit("再试试");
  assert.throws(() => f.route(event, { action: "followup", task_id: source.id }), (error: any) => {
    const detail = JSON.parse(error.message.slice(error.message.indexOf("{")));
    assert.equal(detail.code, "task_closed"); assert.equal(detail.taskRef.id, source.id);
    assert.equal(detail.role_id, f.role.id); assert.equal(detail.recovery.predecessor_task_id, source.id); return true;
  });
  const input = { action: "create", title: "重新检查当前项目文件", role_id: f.role.id, predecessor_task_id: source.id };
  const next = f.route(event, input), duplicate = f.route(event, input);
  assert.equal(next.taskId, duplicate.taskId); assert.notEqual(next.taskId, source.id);
  assert.equal(f.store.list("superGoals").length, 2); assert.equal(f.store.list("superReferences").length, 0);
  assert.deepEqual(f.host.ledger.get(source.id), source); assert.deepEqual(f.store.list("superAcceptance"), oldReceipts);
  assert.deepEqual(f.store.list("superOperations"), oldOperations);
  f.settleRouter(); await f.activate();
  const assignment = f.requests.at(-1)!.input;
  assert.equal(assignment.originalRequirement, "再试试"); assert.equal(assignment.predecessor.originalDeliverable, original.event.payload);
  assert.equal(assignment.predecessor.historicalContextOnly, true); assert.equal(assignment.predecessor.taskRef.id, source.id);
  assert.equal(f.host.ledger.get(next.taskId).modelRounds, 0); assert.equal(f.host.ledger.get(next.taskId).acceptanceState, "not_evaluated");
  assert.equal(f.host.ledger.get(next.taskId).status,"running");
  await f.read(next.taskId); await f.finish(next.taskId); f.settleWorker(next.taskId);
  assert.equal(f.host.ledger.get(next.taskId).acceptanceState, "not_evaluated");
  assert.deepEqual(f.host.ledger.get(source.id), source);
  assert.equal(f.store.list<any>("superOperations").filter((operation) => operation.goalId === next.taskId).length, 1);
});

test("predecessor is context, cannot reuse an old event, cross scope, waive current policy or reset unfinished limits", async (t) => {
  const f = await fixture(t), initial = await f.start(), source = f.host.ledger.get(initial.taskId);
  let event = await f.admit("再检查一次");
  assert.throws(() => f.route(event, { action: "create", title: "检查", role_id: f.role.id, predecessor_task_id: source.id }), (error:any)=>error.status===409);
  f.settleRouter(); await f.finish(); f.settleWorker();
  f.internal.batches.set(f.router, { eventIds: [initial.event.id], complete: new Set([initial.event.id]), input: "old input" });
  assert.throws(() => f.route(initial.event, { action: "create", title: "检查", role_id: f.role.id, predecessor_task_id: source.id }), /disposition/);
  event = await f.admit("重新检查");
  const other = { ...f.role, id: "other-role", roleKey: "other" }; f.store.put("superRoles", other.id, other);
  assert.throws(() => f.route(event, { action: "create", title: "检查", role_id: other.id, predecessor_task_id: source.id }), /project and specialist/);
  const foreign = f.store.createProject("foreign");
  f.store.put("superGoals", "foreign-goal", { ...f.host.ledger.get(source.id), id: "foreign-goal", projectId: foreign.id });
  assert.throws(() => f.route(event, { action: "create", title: "检查", role_id: f.role.id, predecessor_task_id: "foreign-goal" }), /project and specialist/);
  const options = f.store.session(f.router); options.options.denyLocalExecution = true; f.store.put("sessions", f.router, options);
  const next = f.route(event, { action: "create", title: "重新检查", role_id: f.role.id, predecessor_task_id: source.id });
  f.settleRouter(); await f.activate();
  await assert.rejects(f.read(next.taskId), /denies local resource access/);
  assert.equal(f.store.list<any>("superOperations").filter((operation) => operation.goalId === next.taskId).length, 0);
});

for (const routerFirst of [false, true]) test(`accepted followup crosses completion exactly once (router settles first: ${routerFirst})`, async (t) => {
  const f = await fixture(t), initial = await f.start(), before = f.host.ledger.get(initial.taskId);
  const event = await f.admit("再查一下当前文件"); f.route(event, { action: "followup", task_id: initial.taskId });
  if (routerFirst) f.settleRouter();
  assert.equal((await f.finish()).completionDeferred, true);
  assert.equal(f.store.list("superAcceptance").length, 0);
  f.settleWorker();
  if (!routerFirst) { assert.equal(f.worker().state, "parked"); f.settleRouter(); }
  assert.equal(f.worker().state, "queued"); assert.equal(f.steering(), 0);
  await f.activate();
  assert.deepEqual(f.worker().invocationInputIds, [event.id]); assert.equal(f.worker().generation, 2);
  assert.deepEqual(f.requests.at(-1)!.input.followups, [{ id: event.id, text: event.payload }]);
  await f.read(); await f.finish(); f.settleWorker();
  const goal = f.host.ledger.get(initial.taskId);
  assert.equal(goal.status, "completed"); assert.equal(goal.deadlineAt, before.deadlineAt); assert.equal(goal.roundLimit, before.roundLimit);
  assert.equal(f.store.list("superGoals").length, 1);
  assert.deepEqual(f.worker().settledInputIds, [initial.event.id, event.id]);
  assert.equal(f.store.messages(f.router).filter((message) => message.author?.taskId === goal.id).length, 1);
});

for (const routerFirst of [false, true]) test(`failed deferred routing is visible and a new followup skips the failed input (router settles first: ${routerFirst})`, async (t) => {
  const f = await fixture(t), initial = await f.start();
  const failed = await f.admit("第一次补充"); f.route(failed, { action: "followup", task_id: initial.taskId });
  assert.equal((await f.finish()).completionDeferred, true);
  if (routerFirst) f.settleRouter("synthetic routing failure");
  f.settleWorker(); if (!routerFirst) f.settleRouter("synthetic routing failure");
  assert.equal(f.worker().state, "parked"); assert.equal(f.host.ledger.get(initial.taskId).status, "paused");
  assert.ok(f.store.messages(f.router).some((message) => message.text.includes("消息没有处理成功")));
  const retry = await f.admit("新的补充请求"); f.route(retry, { action: "followup", task_id: initial.taskId });
  f.settleRouter(); await f.activate();
  assert.deepEqual(f.worker().invocationInputIds, [retry.id]);
  assert.ok(!JSON.stringify(f.requests.at(-1)!.input.followups).includes(failed.id));
  assert.equal(f.store.require<any>("superInputs", failed.id).disposition, "blocked");
});

test("a parked followup whose Router fails never starts an empty invocation or hides later valid queued activity", async (t) => {
  const f = await fixture(t), initial = await f.start();
  f.settleWorker(); assert.equal(f.worker().state, "parked");
  const failed = await f.admit("重新检查一次"); f.route(failed, { action: "followup", task_id: initial.taskId });
  assert.equal(f.worker().state, "queued");
  f.settleRouter("synthetic routing failure"); await f.activate();
  assert.equal(f.worker().state, "parked"); assert.equal(f.requests.length, 1);
  assert.equal(f.host.ledger.get(initial.taskId).status, "paused");
  assert.ok(f.store.messages(f.router).some((message) => message.text.includes("消息没有处理成功")));
  const retry = await f.admit("这次再检查"); f.route(retry, { action: "followup", task_id: initial.taskId }); f.settleRouter();
  const queued = f.host.workers(f.project.id).find((worker) => worker.task.taskId === initial.taskId)!;
  assert.equal(queued.activity?.phase, "queued"); assert.equal(queued.activity?.sourceMessageId, retry.messageId);
  await f.activate(); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.worker().invocationInputIds, [retry.id]);
  assert.deepEqual(f.requests.at(-1)!.input.followups, [{ id: retry.id, text: retry.payload }]);
  assert.equal(f.store.require<any>("superInputs", failed.id).disposition, "blocked");
});

test("stop wins a deferred finish and cannot be requeued by late Router completion", async (t) => {
  const f = await fixture(t), initial = await f.start();
  const event = await f.admit("继续检查"); f.route(event, { action: "followup", task_id: initial.taskId });
  await f.finish(); await f.host.stopTask(initial.taskId); f.settleWorker(); f.settleRouter(); await f.activate();
  assert.equal(f.worker().state, "stopped"); assert.equal(f.host.ledger.get(initial.taskId).status, "cancelled");
  assert.equal(f.requests.length, 1); assert.equal(f.store.list("superAcceptance").length, 0);
});

for(const readOnly of [true,false])test(`stop waits for ${readOnly?'read':'opaque write'} settlement before reporting and preserves a concurrent sibling`,async t=>{
 const f=await fixture(t),a=await f.start();
 const event=await f.admit('独立任务 B');const b=f.route(event,{action:'create',title:'独立任务 B',role_id:f.role.id});f.settleRouter();await f.activate();await f.read(b.taskId);
 let release!:()=>void,aborted!:()=>void,started!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),abortGate=new Promise<void>(resolve=>{aborted=resolve;}),startGate=new Promise<void>(resolve=>{started=resolve;});
 const worker=f.worker(a.taskId);
 const business=f.internal.serializeBusiness(worker.id,()=>f.host.ledger.operation(a.taskId,worker.generation,worker.policyHash,'in-flight','Bash',{},async()=>{
  started();await gate;if(!readOnly)throw new Error('opaque process interrupted');return {status:'cancelled',cancelled:true,exitCode:137};
 },(v:any)=>v,{readOnly}));
 const settled=business.catch(()=>{});await startGate;
 (f.agents as any).abort=async(session:string)=>{assert.equal(session,worker.sessionId);f.settleWorker(a.taskId);aborted();};
 const sibling=JSON.stringify(f.worker(b.taskId)),stopping=f.host.stopTask(a.taskId),duplicate=f.host.stopTask(a.taskId);await abortGate;
 assert.equal(f.store.messages(f.router).filter(m=>m.author?.taskId===a.taskId).length,0,'no provisional report while a receipt is in flight');
 assert.equal(f.worker(a.taskId).generation,worker.generation+1,'duplicate stop is coalesced');
 assert.equal(JSON.stringify(f.worker(b.taskId)),sibling);
 release();await settled;await Promise.all([stopping,duplicate]);
 const report=f.store.messages(f.router).filter(m=>m.author?.taskId===a.taskId);
 assert.equal(report.length,1);assert.equal(report[0]!.text,'已停止这次工作。');
 assert.equal(f.host.ledger.get(a.taskId).status,'cancelled');
 const op=f.store.list<any>('superOperations').find(o=>o.callId==='in-flight');assert.equal(op.status,readOnly?'failed':'unknown');
 f.settleWorker(a.taskId);assert.equal(f.store.messages(f.router).filter(m=>m.author?.taskId===a.taskId).length,1,'late completion cannot add another stop report');
 await f.finish(b.taskId);f.settleWorker(b.taskId);assert.equal(f.host.ledger.get(b.taskId).acceptanceState,"not_evaluated");
});

test('stopping the remaining reply after business acceptance preserves the accepted goal and receipts',async t=>{
 const f=await fixture(t),work=await f.start();await f.finish(work.taskId);
 const goal=JSON.stringify(f.host.ledger.get(work.taskId)),receipts=JSON.stringify(f.store.list('superAcceptance'));
 (f.agents as any).abort=async()=>f.settleWorker(work.taskId);
 await f.host.stopTask(work.taskId);
 assert.equal(JSON.stringify(f.host.ledger.get(work.taskId)),goal);assert.equal(JSON.stringify(f.store.list('superAcceptance')),receipts);
 const reports=f.store.messages(f.router).filter(message=>message.author?.taskId===work.taskId);
 assert.equal(reports.length,1);assert.equal(reports[0]!.text,'已读取本次项目文件列表。');
});

test("explicit resume dispatches once without a new message and preserves the original task limits", async (t) => {
  const f = await fixture(t), initial = await f.start();
  f.settleWorker();
  const before = f.host.ledger.get(initial.taskId);
  await f.host.control(before.sessionId, { goalId: before.id, revision: before.revision, command: "resume" });
  const controlId = f.worker().resumeControlId;
  assert.ok(controlId); assert.equal(f.host.workers(f.project.id)[0].activity?.phase, "queued");
  await f.activate();
  assert.equal(f.requests.length, 2); assert.equal(f.worker().resumeControlId, undefined);
  assert.deepEqual(f.worker().invocationInputIds, []); assert.deepEqual(f.requests.at(-1)!.input.followups, []);
  assert.equal(f.requests.at(-1)!.input.humanControl.command, "resume");
  const control = f.store.require<any>("superHumanControls", controlId);
  assert.ok(control.consumedAt); assert.equal(control.generation, f.worker().generation);
  f.settleWorker(); await f.activate();
  assert.equal(f.requests.length, 2); assert.equal(f.worker().state, "parked");
  const after = f.host.ledger.get(initial.taskId);
  assert.equal(after.deadlineAt, before.deadlineAt); assert.equal(after.roundLimit, before.roundLimit);
  assert.equal(after.modelRounds, before.modelRounds); assert.equal(f.store.list("superGoals").length, 1);
});

test("stop revokes a queued explicit resume before dispatch", async (t) => {
  const f = await fixture(t), initial = await f.start(); f.settleWorker();
  const goal = f.host.ledger.get(initial.taskId);
  await f.host.control(goal.sessionId, { goalId: goal.id, revision: goal.revision, command: "resume" });
  const controlId = f.worker().resumeControlId;
  await f.host.stopTask(goal.id); await f.activate();
  assert.equal(f.requests.length, 1); assert.equal(f.worker().state, "stopped");
  assert.equal(f.worker().resumeControlId, undefined);
  const control = f.store.require<any>("superHumanControls", controlId);
  assert.ok(control.revokedAt); assert.equal(control.consumedAt, undefined);
});

test("cold restart and unrelated conversation never resume an interrupted worker", async (t) => {
  const f = await fixture(t), initial = await f.start();
  await f.host.close();
  const recovered = new LakeSuperagent(f.store, f.agents as any), internal = recovered as any;
  internal.schedule = () => {};
  try {
    assert.equal(f.worker().state, "parked");
    assert.equal(recovered.ledger.get(initial.taskId).status, "paused");
    const message = await recovered.send(f.router, "解释一下刚才的结果") as { id: string };
    const event = f.store.list<any>("superInputs").find((item) => item.messageId === message.id)!;
    internal.batches.set(f.router, { eventIds: [event.id], complete: new Set([event.id]), input: JSON.stringify({ event: event.id }) });
    internal.route(f.router, { event_id: event.id, part_key: "explanation", quote: event.payload, action: "respond", reason: "explanation only" });
    const view = f.store.view(f.router); view.status = "completed"; f.store.put("views", f.router, view);
    internal.routerFinished(f.router); await internal.pump();
    assert.equal(f.worker().state, "parked"); assert.equal(recovered.ledger.get(initial.taskId).status, "paused");
    assert.equal(f.requests.length, 1); assert.equal(f.store.list("superAcceptance").length, 0);
  } finally { await recovered.close(); }
});

for (const limit of ["deadline"]) test(`deferred completion preserves the original ${limit} limit and reports it`, async (t) => {
  const f = await fixture(t), initial = await f.start();
  const event = await f.admit("继续检查"); f.route(event, { action: "followup", task_id: initial.taskId });
  await f.finish();
  const goal = f.host.ledger.get(initial.taskId);
  goal.deadlineAt = new Date(Date.now() - 1000).toISOString();
  f.host.ledger.save(goal); f.settleWorker(); f.settleRouter(); await f.activate();
  const after = f.host.ledger.get(goal.id);
  assert.equal(after.status, "paused"); assert.equal(after.summary, "deadline_reached");
  assert.equal(after.deadlineAt, goal.deadlineAt); assert.equal(after.modelRounds, goal.modelRounds);
  assert.equal(f.worker().state, "parked"); assert.equal(f.store.list("superAcceptance").length, 0);
  assert.ok(f.store.messages(f.router).some((message) => message.text.includes("截止时间")));
});

test('Pilot stop fences current queued/active work and late decisions without changing parked history or other projects',async t=>{
 const f=await fixture(t),old=await f.start();await f.finish();f.settleWorker();
 const oldGoal=JSON.stringify(f.host.ledger.get(old.taskId));
 const current=await f.start(),active=f.worker(current.taskId);
 f.store.put('superOperations','uncertain',{id:'uncertain',goalId:current.taskId,projectId:f.project.id,sessionId:active.sessionId,status:'unknown'});
 const pending=await f.admit('另外读取一项当前文件记录。');const queued=f.route(pending,{action:'create',title:'排队的独立工作',role_id:f.role.id});
 const other=f.store.createProject('other project');f.host.ensure(other.id);
 f.store.put('superWorkers','other-worker',{...active,id:'other-worker',projectId:other.id});
 await assert.rejects(()=>f.host.stopWorkspace(f.project.id,'wrong-router'),/不属于/);
 const count=f.requests.length,result=await f.host.stopWorkspace(f.project.id,f.router);
 assert.equal(result.tasks,2);assert.equal(f.worker(current.taskId).state,'stopped');
 assert.equal(f.host.ledger.get(current.taskId).status,'cancelled');assert.equal(f.store.get<any>('superOperations','uncertain')!.status,'unknown');
 assert.equal(f.host.ledger.get(queued.taskId).status,'cancelled');assert.equal(f.store.get<any>('superInputs',pending.id)!.disposition,'stopped');
 assert.equal(JSON.stringify(f.host.ledger.get(old.taskId)),oldGoal);assert.equal(f.store.get<any>('superWorkers','other-worker')!.state,'active');
 assert.throws(()=>f.route(pending,{action:'create',title:'迟到任务',role_id:f.role.id}));
 f.settleRouter();await f.activate();assert.equal(f.requests.length,count);
});

test('a distinct follow-on task recalls same-role entrance clarifications and reports without borrowing execution authority',async t=>{
 const f=await fixture(t);
 const event=await f.admit('比较源库与 K2 数据。'),first=f.route(event,{action:'create',title:'比较两端数据库',role_id:f.role.id});
 f.settleRouter();await f.activate();await f.read(first.taskId);f.settleWorker(first.taskId);
 const entrance=await f.admit('192.0.2.75 是 K2 入口。');f.route(entrance,{action:'followup',task_id:first.taskId});
 f.settleRouter();await f.activate();
 const old=f.host.ledger.get(first.taskId);old.summary='K2 的数据库实例为 db/mysql141-0；这次只做了历史比较。';f.host.ledger.save(old);f.settleWorker(first.taskId);
 await f.host.stopTask(first.taskId);
 const original=JSON.stringify(f.host.ledger.get(first.taskId)),receipts=JSON.stringify(f.store.list('superOperations'));
 const next=await f.admit('同步到k2'),handoff=f.route(next,{action:'create',title:'同步源库到 K2',role_id:f.role.id});
 f.settleRouter();await f.activate();
 const assigned=f.requests.at(-1)!.input,previous=assigned.taskContext.items.find((row:any)=>row.taskRef.id===first.taskId);
 assert.match(JSON.stringify(previous),/192\.0\.2\.75/);assert.match(previous.summary,/db\/mysql141-0/);
 assert.equal(previous.historicalContextOnly,true);assert.equal(previous.state,'cancelled');
 assert.notEqual(assigned.assignment.sessionId,f.worker(first.taskId).sessionId);
 assert.equal(f.store.list<any>('superOperations').filter(op=>op.goalId===handoff.taskId).length,0);
 assert.equal(f.host.ledger.get(handoff.taskId).acceptanceState,'not_evaluated');
 const current=f.worker(handoff.taskId),recall=f.host.profile(current.sessionId)!.tools.find(tool=>tool.metadata.name==='recall_task_context')!;
 const found:any=await recall.handler({task_id:first.taskId,revision:previous.taskRef.revision,expected_hash:previous.taskRef.hash},{abortSignal:new AbortController().signal} as any);
 assert.equal(found.items[0].taskRef.id,first.taskId);
 await assert.rejects(async()=>recall.handler({task_id:first.taskId,expected_hash:'stale'},{abortSignal:new AbortController().signal} as any),/hash changed/);
 assert.equal(JSON.stringify(f.host.ledger.get(first.taskId)),original);assert.equal(JSON.stringify(f.store.list('superOperations')),receipts);
});

test('task recall rejects a different role and forged actor, and provider projection refreshes only the latest exact assignment',async t=>{
 const f=await fixture(t),first=await f.start();f.settleWorker(first.taskId);
 const next=await f.admit('进行另一项工作'),created=f.route(next,{action:'create',title:'后续工作',role_id:f.role.id});f.settleRouter();await f.activate();
 const current=f.worker(created.taskId),profile=f.host.profile(current.sessionId)!;
 const foreign={...f.worker(first.taskId),id:'other-worker',taskId:'other-task',roleId:'other-role'};
 f.store.put('superWorkers',foreign.id,foreign);f.store.put('superGoals',foreign.taskId,{...f.host.ledger.get(first.taskId),id:foreign.taskId,workerId:foreign.id,roleId:foreign.roleId});
 const recall=profile.tools.find(tool=>tool.metadata.name==='recall_task_context')!;
 await assert.rejects(async()=>recall.handler({task_id:foreign.taskId},{abortSignal:new AbortController().signal} as any),/not found/);
 const assigned=f.requests.at(-1)!.input;
 const request={messages:[{role:'system',content:'preserve system'},{role:'user',content:JSON.stringify({...assigned,taskContext:{stale:'OLD_CONTEXT'}})},{role:'assistant',content:'old reasoning'},{role:'user',content:JSON.stringify(assigned)}]};
 const before=JSON.stringify(request),projected:any=profile.projectRequest!(request);
 assert.equal(JSON.parse(projected.messages[1].content).taskContext,undefined);
 assert.equal(JSON.parse(projected.messages[3].content).taskContext.items[0].taskRef.id,first.taskId);
 assert.equal(projected.messages[2],request.messages[2]);assert.equal(JSON.stringify(request),before);
});

test('task context enforces actual actor identity and UTF-8/JSON budgets across paged history',async t=>{
 const {TaskContext}=await import('./task-context');
 const f=await fixture(t),first=await f.start(),current=f.worker(first.taskId),goal=f.host.ledger.get(first.taskId),context=new TaskContext(f.store,value=>value);
 for(let index=0;index<12;index++){
  const taskId='history-'+index,workerId='history-worker-'+index,sessionId='history-session-'+index;
  f.store.put('superGoals',taskId,{...goal,id:taskId,workerId,sessionId,summary:'中文上下文和入口线索。'.repeat(3000),title:'历史任务 '+index});
  f.store.put('superWorkers',workerId,{...current,id:workerId,taskId,sessionId,createdAt:`2026-11-06T08:00:${String(index).padStart(2,'0')}Z`,inputEventIds:[]});
 }
 const actor={projectId:current.projectId,roleId:current.roleId,sessionId:current.sessionId,taskId:current.taskId};
 const before=JSON.stringify(f.store.list('superGoals'));
 assert.throws(()=>context.recall({...actor,projectId:'foreign'}),/actor not found/);
 let cursor='',ids:string[]=[];
 do{const page=context.recall(actor,{limit:6,cursor});assert.ok(Buffer.byteLength(JSON.stringify(page))<=16384);for(const row of page.items){assert.ok(Buffer.byteLength(JSON.stringify(row))<=4096);assert.doesNotMatch(JSON.stringify(row),/�/);ids.push(row.taskRef.id);}cursor=page.nextCursor;}while(cursor);
 assert.equal(new Set(ids).size,12);assert.equal(ids.length,12);assert.equal(JSON.stringify(f.store.list('superGoals')),before);
});

test("shared handoff binds each contribution and scoped stop to its exact participant", async (t) => {
  const f = await fixture(t);
  const second = { ...f.role, id: "role-b", name: "数据库专员" };
  f.store.put("superRoles", second.id, second);
  const event = await f.admit("甲乙一起检查系统和数据库");
  const input = { action: "create", title: "联合检查", role_ids: [f.role.id, second.id], role_instructions: [
    { role_id: f.role.id, instruction: "只核对主机" }, { role_id: second.id, instruction: "只核对库表" },
  ] };
  const receipt = f.route(event, input), retry = f.route(event, input);
  const [a, b] = receipt.assignments;
  assert.equal(receipt.workerId, undefined);
  assert.equal(receipt.taskId, retry.taskId);
  assert.deepEqual(retry.assignments.map((row: any) => row.executionId), [a.executionId, b.executionId]);
  assert.notEqual(a.workerId, b.workerId);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.deepEqual(f.host.workspace(f.project.id).workers.map(worker => worker.task.taskId), [receipt.taskId, receipt.taskId]);
  assert.throws(() => f.route(event, { ...input, part_key: "overlap", role_ids: [second.id], role_instructions: [] }), /Overlapping/);
  f.settleRouter(); await f.activate();
  assert.deepEqual(f.requests.map(call => call.input.assignedDeliverable).sort(), ["只核对主机", "只核对库表"].sort());
  assert.ok(f.requests.every(call => call.input.assignment.taskId === receipt.taskId));
  const readTask = (args: object) => JSON.parse(f.internal.readObject(f.router, { kind: "task", id: receipt.taskId, ...args }).content);
  assert.equal(readTask({}).participants.length, 2);
  assert.equal(readTask({ role_id: second.id }).id, b.executionId);
  const followup = await f.admit("仅给乙补充：核对数据库名称");
  assert.equal(f.route(followup, { action: "followup", task_id: receipt.taskId, role_id: second.id }).workerId, b.workerId);
  assert.equal(f.worker(a.executionId).inputEventIds.includes(followup.id), false);
  f.settleRouter();
  const stop = await f.admit("只停止乙");
  assert.throws(() => f.route(stop, { action: "stop", task_id: receipt.taskId }), /participant role_id/);
  assert.throws(() => f.route(stop, { action: "stop", task_id: receipt.taskId, role_id: "unknown" }), /not assigned/);
  const stopped = f.route(stop, { action: "stop", task_id: receipt.taskId, role_id: second.id });
  assert.equal(stopped.workerId, b.workerId);
  f.settleRouter();
  await f.host.stopTask(b.executionId); // join the stop already dispatched by the Router
  assert.equal(f.host.ledger.get(b.executionId).status, "cancelled");
  assert.equal(f.host.ledger.get(a.executionId).status, "running");
});

test("Pilot cannot borrow a different specialist's receipt and can add a participant to the original task", async (t) => {
  const f = await fixture(t), second = { ...f.role, id: "beta" };
  f.store.put("superRoles", second.id, second);
  const initial = await f.admit("检查数据库"); const create = { action: "create", title: "检查数据库", role_id: f.role.id };
  const first = f.route(initial, create);
  assert.throws(() => f.route(initial, { ...create, role_id: second.id }), /decision conflict/);
  assert.throws(() => f.route(initial, { ...create, role_id: second.id, part_key: "other" }), /Overlapping/);
  f.settleRouter();
  const event = await f.admit("把乙加到刚才的任务，一起核对数据库");
  for (const action of ["stop", "followup", "context_only"]) {
    assert.throws(() => f.route(event, { action, task_id: first.taskId, role_id: second.id }), /not found in source specialist/);
  }
  assert.throws(() => f.route(event, { action: "assign", task_id: first.taskId, role_ids: [second.id, "unknown"] }));
  assert.equal(f.store.list("superWorkers").length, 1);
  const input = { action: "assign", task_id: first.taskId, role_id: second.id };
  const joined = f.route(event, input);
  assert.equal(joined.taskId, first.taskId);
  assert.equal(joined.roleId, second.id);
  assert.notEqual(joined.sessionId, first.sessionId);
  assert.equal(f.route(event, input).workerId, joined.workerId);
  f.settleRouter(); await f.activate();
  const b = f.requests.find(call => call.sessionId === joined.sessionId)?.input;
  assert.equal(b.originalRequirement, initial.payload);
  assert.deepEqual(b.followups, [{ id: event.id, text: event.payload }]);
  assert.equal(b.assignment.taskId, first.taskId);
  const channel = f.store.require<any>("superChannels", second.id);
  await f.host.send(channel.sessionId, "在乙频道继续", first.taskId);
  const request = f.store.list<any>("superInputs").find(row => row.payload === "在乙频道继续");
  f.internal.batches.set(f.router, { eventIds: [request.id], complete: new Set([request.id]), input: request.payload });
  assert.throws(() => f.route(request, { action: "followup", task_id: first.taskId, role_id: f.role.id }), /not found in source specialist/);
  assert.equal(f.route(request, { action: "followup", task_id: first.taskId }).workerId, joined.workerId);
});

test("a registered joint result exposes both original roles' evidence and rejects a changed member revision", async (t) => {
  const f = await fixture(t), secondary = { ...f.role, id: "role-b" };
  f.store.put("superRoles", secondary.id, secondary);
  const event = await f.admit("一起检查文件");
  const joint = f.route(event, { action: "create", title: "检查文件", role_ids: [f.role.id, secondary.id] });
  f.settleRouter(); await f.activate();
  for (const assignment of joint.assignments) {
    await f.read(assignment.executionId);
    await f.finish(assignment.executionId);
    f.settleWorker(assignment.executionId);
  }
  const review = await f.admit("读取上次联合检查的证据");
  const handoff = f.route(review, { action: "create", role_id: f.role.id, title: "复核结果", evidence_task_ids: [joint.taskId] });
  const actor = f.worker(handoff.taskId);
  const rows = f.internal.referencedEvidence(actor, { task_id: joint.taskId }).items;
  assert.deepEqual(rows.map((row: any) => row.roleId).sort(), [f.role.id, secondary.id].sort());
  for (const row of rows) {
    assert.equal(f.internal.readReferenced(actor, { task_id: joint.taskId, evidence_id: row.evidenceId, reference_id: row.referenceId }).state, "succeeded");
  }
  f.host.ledger.save(f.host.ledger.get(joint.assignments[1].executionId));
  assert.throws(() => f.internal.referencedEvidence(actor, { task_id: joint.taskId }), /source changed/);
});

for (const recovery of ["followup", "resume"] as const) test(`a failed additional handoff starts only on exact ${recovery} and preserves unknown operations`, async t => {
  const f = await fixture(t), first = await f.start();
  const beta = { ...f.role, id: "beta" }; f.store.put("superRoles", beta.id, beta);
  const addition = await f.admit("请让乙加入核对");
  const handoff = f.route(addition, { action: "assign", task_id: first.taskId, role_id: beta.id });
  f.settleRouter("simulated provider error after tool response");
  const a = f.worker(first.taskId), b = f.worker(handoff.assignments[0].executionId);
  assert.equal(b.state, "parked");
  await f.activate();
  assert.equal(f.requests.filter(call => call.sessionId === b.sessionId).length, 0);
  let dispatches = 0;
  const mutation = { path: "example" };
  await assert.rejects(f.host.ledger.operation(a.taskId, a.generation, a.policyHash, "write-A", "Write", mutation, async () => {
    dispatches++; throw new Error("unsettled external write");
  }, x => x, { readOnly: false }), /unsettled external write/);
  const prior = f.store.list<any>("superOperations").find(op => op.callId === "write-A");
  assert.equal(prior.status, "unknown");

  const unrelated = await f.admit("仅和甲继续");
  f.route(unrelated, { action: "followup", task_id: first.taskId, role_id: f.role.id });
  f.settleRouter(); await f.activate();
  assert.equal(f.requests.filter(call => call.sessionId === b.sessionId).length, 0);

  if (recovery === "followup") {
    const retry = await f.admit("继续乙自己的分工");
    f.route(retry, { action: "followup", task_id: first.taskId, role_id: beta.id });
    f.settleRouter();
  } else {
    await f.host.control(b.sessionId, { command: "resume", goalId: first.taskId, revision: f.host.ledger.get(b.taskId).revision });
  }
  await f.activate();
  const member = f.worker(b.taskId), runs = f.requests.filter(call => call.sessionId === b.sessionId);
  assert.equal(member.state, "active");
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].input.followups.map((row: any) => row.text), recovery === "followup" ? ["继续乙自己的分工"] : []);
  assert.equal(f.store.require<any>("superInputs", addition.id).disposition, "blocked");
  await f.read(member.taskId);
  const read = f.host.profile(member.sessionId)!.tools.find(entry => entry.metadata.name === "work_read")!;
  const snapshot = await read.handler({ goal_id: first.taskId }, { abortSignal: new AbortController().signal } as any) as any;
  assert.equal(snapshot.goal.id, member.taskId);
  assert.ok(snapshot.operations.length && snapshot.operations.every((op: any) => op.goalId === member.taskId));
  await f.host.ledger.operation(member.taskId, member.generation, member.policyHash, "write-B", "Write",
    mutation, async () => { dispatches++; return {}; }, x => x, { readOnly: false });
  assert.equal(dispatches, 2);
  assert.deepEqual(f.store.require("superOperations", prior.id), prior);
});

async function watchdogFixture(t: Parameters<typeof fixture>[0], joint = false) {
  let time = Date.now();
  const f = await fixture(t, () => time);
  const second = { ...f.role, id: "watchdog-db", name: "数据库专员" };
  f.store.put("superRoles", second.id, second);
  const event = await f.admit("运维检查主机，数据库专员检查慢查询");
  const handoff = f.route(event, {
    action: "create", title: "共同排查超时",
    ...(joint ? {role_ids:[f.role.id,second.id],role_instructions:[
      {role_id:f.role.id,instruction:"检查主机"}, {role_id:second.id,instruction:"检查慢查询"}]} : {role_id:f.role.id}),
  });
  f.settleRouter();
  await f.activate();
  const member = f.worker(handoff.assignments[0].executionId);
  const fail = (statusCode = 503, currentFailure = true) => {
    const current = f.worker(member.taskId);
    const view = f.store.view(current.sessionId);
    view.rootTurnId = currentFailure ? "watchdog-root-" + current.generation : "previous-sdk-root";
    view.status = "failed";
    const failure = {message:"provider rejected",source:"provider",statusCode,phase:"response",retryable:statusCode===503};
    view.cards.push({id:"failure-"+current.generation,at:new Date(time).toISOString(),type:"error",status:"failed",content:"provider rejected",
      data:{root_turn_id:view.rootTurnId,taskId:current.taskId,failure}});
    f.store.put("views",current.sessionId,view);
    // A setup error may not emit an SDK root at all. The view can then still
    // show the previous turn's failure, matching its old root ID perfectly.
    f.host.settled(current.sessionId,currentFailure ? {error:failure.message,failure} : {error:"本轮本地准备失败"});
  };
  return {...f, member, fail, event, handoff, advance:(ms:number)=>{time+=ms;}};
}

test("watchdog retries a scoped pre-execution outage once due and marks recovery after the original execution submits its report", async t => {
  const f = await watchdogFixture(t), before = f.host.ledger.get(f.member.taskId);
  f.host.setWatchdogMode(f.project.id,"guide");
  f.fail();
  const ticket=f.store.require<any>("superWatchdogRetry",f.member.id);
  assert.equal(ticket.generation,f.member.generation);
  assert.deepEqual(ticket.inputIds,[f.event.id]);
  f.advance(59_999); await f.host.scanWatchdog(); await f.activate();
  assert.equal(f.requests.length,1);
  f.advance(1); await f.host.scanWatchdog(); await f.activate(); await f.activate();
  assert.equal(f.requests.length,2);
  const retry=f.requests[1]!;
  assert.equal(retry.sessionId,f.member.sessionId);
  assert.equal(retry.input.assignment.executionId,f.member.taskId);
  assert.equal(f.worker().generation,f.member.generation+1);
  assert.equal(f.host.ledger.get(f.member.taskId).deadlineAt,before.deadlineAt);
  assert.equal(f.store.list("superAcceptance").length,0);
  assert.equal(f.host.watchdog.records(f.project.id,f.member.taskId)[0]?.state,"retry_queued");
  await f.read(f.member.taskId); await f.finish(f.member.taskId); f.settleWorker(f.member.taskId);
  assert.equal(f.host.watchdog.records(f.project.id,f.member.taskId)[0]?.state,"recovered");
  assert.equal(f.host.ledger.get(f.member.taskId).acceptanceState,"not_evaluated");
  assert.equal(f.store.list("superGoals").length,1);
});

test("watchdog retry backoff stops after two actual retries on the original execution", async t => {
  const f=await watchdogFixture(t);
  f.host.setWatchdogMode(f.project.id,"guide");
  f.fail(); f.advance(60_000); await f.activate();
  f.fail(); f.advance(299_999); await f.activate();
  assert.equal(f.requests.length,2);
  f.advance(1); await f.activate();
  assert.equal(f.store.require<any>("superWatchdogLastRetry",f.member.id).attempt,2);
  f.fail(); f.advance(600_000); await f.host.scanWatchdog(); await f.activate();
  assert.equal(f.requests.length,3);
  assert.equal(f.store.get("superWatchdogRetry",f.member.id),undefined);
  assert.equal(f.store.list("superAcceptance").length,0);
});

for (const intervention of ["stop","disable","permission","unresolved sibling","restart"] as const) {
  test("watchdog pending recovery honors " + intervention, async t => {
    const f=await watchdogFixture(t,intervention==="unresolved sibling");
    f.host.setWatchdogMode(f.project.id,"guide");
    f.fail();
    assert.ok(f.store.get("superWatchdogRetry",f.member.id));
    const before=f.requests.length;
    if (intervention==="stop") await f.host.stopTask(f.member.taskId);
    if (intervention==="disable") f.host.setWatchdogMode(f.project.id,"off");
    if (intervention==="permission") {
      const session=f.store.session(f.router); session.options.denyLocalExecution=true;
      f.store.put("sessions",session.id,session);
    }
    if (intervention==="unresolved sibling") {
      const b=f.worker(f.handoff.assignments[1].executionId);
      await assert.rejects(f.host.ledger.operation(b.taskId,b.generation,b.policyHash,"ambiguous-change","Write",
        {path:"fixture"}, async()=>{throw new Error("delivery unknown");},value=>value,{readOnly:false}));
    }
    f.advance(600_000);
    if (intervention==="restart") {
      await f.host.close();
      const restored=new LakeSuperagent(f.store,f.agents as any,undefined,undefined,undefined,undefined,undefined,()=>Date.now()+600_000);
      try { await (restored as any).pump(); } finally { await restored.close(); }
    } else {
      await f.host.scanWatchdog();
      await f.activate();
    }
    assert.equal(f.requests.length,before+(intervention==="unresolved sibling"?1:0));
    assert.equal(!!f.store.get("superWatchdogLastRetry",f.member.id),intervention==="unresolved sibling");
    assert.equal(f.store.get("superWatchdogRetry",f.member.id),undefined);
    assert.equal(f.store.list("superAcceptance").length,0);
  });
}

test("watchdog only retries a transient model failure bound to this turn, before any business operations",async t=>{
  for (const condition of ["previous failure only","authentication","operation","observe"] as const) {
    const f=await watchdogFixture(t);
    if(condition!=="observe")f.host.setWatchdogMode(f.project.id,"guide");
    if(condition==="operation")await f.read(f.member.taskId);
    f.fail(condition==="authentication"?401:503,condition!=="previous failure only");
    f.advance(600_000); await f.activate();
    assert.equal(f.requests.length,1,condition);
    assert.equal(f.store.get("superWatchdogRetry",f.member.id),undefined,condition);
  }
});

test("watchdog reviews repeated identical evidence only on the affected member, preserving a sibling waiting on approval",async t=>{
  const f=await watchdogFixture(t,true);
  const a=f.member,b=f.worker(f.handoff.assignments[1].executionId);
  const pending={id:"original-approval",fingerprint:"fixed",call:{name:"Read"}} as any;
  const aView=f.store.view(a.sessionId); aView.pending=pending; f.store.put("views",a.sessionId,aView);
  const reviews:{projectId:string;sessionId:string;assignment:string;observations:string[]}[]=[], guided:string[]=[];
  Object.assign(f.agents,{
    isRunning:(sessionId:string)=>[a.sessionId,b.sessionId].includes(sessionId),
    currentActivity:()=>undefined,hasActiveChildren:()=>false,
    reviewWatchdog:async(input:typeof reviews[number])=>{reviews.push(input);return {verdict:"stalled",reason:"重复取得相同文件清单。"};},
    steer:async(sessionId:string)=>{guided.push(sessionId);return true;},
  });
  f.host.setWatchdogMode(f.project.id,"guide");
  await f.read(b.taskId,"first-file-list"); await f.host.scanWatchdog();
  for(let i=0;i<3;i++){
    f.advance(60_000); await f.read(b.taskId,"repeated-"+i); await f.host.scanWatchdog();
  }
  assert.deepEqual(reviews.map(input=>[input.sessionId,input.assignment]),[[b.sessionId,"检查慢查询"]]);
  assert.ok(reviews[0]!.observations.some(line=>line.includes("4 次工具调用") && line.includes("1 组")));
  assert.deepEqual(guided,[b.sessionId]);
  assert.equal(f.host.watchdog.records(f.project.id,a.taskId).length,0);
  const record=f.host.watchdog.records(f.project.id,b.taskId)[0]!;
  assert.deepEqual([record.taskId,record.executionId,record.workerId,record.state],[f.handoff.taskId,b.taskId,b.id,"guided"]);
  assert.deepEqual(f.store.view(a.sessionId).pending,pending);
  assert.equal(f.store.list("superAcceptance").length,0);
});

test("watchdog distinguishes changed foreground Bash output from a replay with a new command handle",async t=>{
  const f=await watchdogFixture(t);
  Object.assign(f.agents,{isRunning:()=>true,currentActivity:()=>undefined,hasActiveChildren:()=>false});
  const sample=()=>f.internal.watchdogSample(f.member.id);
  const command=(id:string,stdout:string,background:boolean)=>{
    // Foreground Bash returns flat strings, a settled background command
    // returns the SDK execution result with stdout/stderr text envelopes.
    const output={exitCode:0,stdout:background?{text:stdout}:stdout,stderr:background?{text:""}:""};
    f.store.put("superOperations",id,{id,projectId:f.project.id,sessionId:f.member.sessionId,
      goalId:f.member.taskId,generation:f.member.generation,tool:"Bash",argsHash:"same-shell-command",
      resourceId:"local",commandExecutionId:id,status:"succeeded",output,outputHash:id,readOnly:true});
  };
  command("one","ready",false); const first=sample().progressKey;
  command("two","ready",false); assert.equal(sample().progressKey,first);
  command("three","updated",false); const changed=sample().progressKey;
  assert.notEqual(first,changed,"a foreground command produced distinct evidence");
  command("four","updated",true); assert.equal(sample().progressKey,changed,"background Bash produced the same evidence");
  assert.doesNotMatch(JSON.stringify(sample().evidence),/updated|ready/,"raw output is not sent to the reviewer");
});

test("one human quote can dispatch disjoint selected resources and execution cannot cross the original assignment", async t=>{
  const f=await fixture(t), ids=["jd","uk"];
  for(const id of ids) f.store.put("resources",id,{id,projectId:f.project.id,name:id,kind:"ssh",status:"available"});
  const selected:MessageInput={resourceIds:ids,mentions:[],references:[]};
  const event=await f.admit("请分别巡检两台服务器并独立提交",selected);
  const create={action:"create",role_id:f.role.id};
  assert.throws(()=>f.route(event,{...create,title:"检查全部"}),/multiple resources/);
  assert.throws(()=>f.route(event,{...create,title:"检查第三台",resource_ids:["other"]}),/subset/);
  const jd=f.route(event,{...create,title:"检查京东云",resource_ids:["jd"]});
  assert.throws(()=>f.route(event,{...create,part_key:"overlapping",title:"检查有交集的两台",resource_ids:ids}),/Overlapping/);
  const uk=f.route(event,{...create,title:"检查优刻云",part_key:"uk",resource_ids:["uk"]});
  assert.notEqual(jd.taskId,uk.taskId);
  f.settleRouter();await f.activate();
  for(const [receipt,resource,title] of [[jd,"jd","检查京东云"],[uk,"uk","检查优刻云"]] as const){
    const worker=f.worker(receipt.taskId), input=f.requests.find(req=>req.sessionId===worker.sessionId)!.input;
    assert.deepEqual(input.assignment.targetResourceIds,[resource]);
    assert.deepEqual(input.selectedReferences.resourceIds,[resource]);
    assert.equal(input.assignedDeliverable,title);
    const profile=f.host.profile(worker.sessionId)!;
    assert.ok(!profile.allowlist.includes("WebSearch")&&!profile.allowlist.includes("Read")&&!profile.allowlist.includes("list_project_files"));
    const listing=profile.tools.find(tool=>tool.metadata.name==="list_assets")!;
    const result=await listing.handler({}, {abortSignal:new AbortController().signal} as any) as any;
    assert.deepEqual(result.assets.map((asset:any)=>asset.asset_ref),[resource]);
  }
  const worker=f.worker(jd.taskId),profile=f.host.profile(worker.sessionId)!;
  let scopedRequests: string[] | undefined;
  f.internal.execution={plan:(_p:string,i:{asset_ref?:string},requests:string[])=>{
    scopedRequests=requests;return {resource:{id:i.asset_ref??"local",kind:i.asset_ref?"ssh":"local"},readOnly:true};
  }};
  assert.throws(()=>f.internal.shellPlan(worker,{command:"hostname"}),/分工/);
  assert.throws(()=>f.internal.shellPlan(worker,{command:"hostname",asset_ref:"uk"}),/分工/);
  assert.equal(f.internal.shellPlan(worker,{command:"hostname",asset_ref:"jd"}).plan.resource.id,"jd");
  assert.deepEqual(scopedRequests,[], "a multi-resource quote cannot attest a path on either host");
  const single=await f.admit("检查 /tmp/example 的目录", {resourceIds:["jd"],mentions:[],references:[]});
  f.internal.shellPlan({...worker,inputEventIds:[event.id,single.id]},{command:"hostname",asset_ref:"jd"});
  assert.deepEqual(scopedRequests,[single.payload]);
  f.internal.ssh={};
  const inspect=f.internal.hostEntries(worker)[0];
  assert.throws(()=>inspect.resolvePermissionCapability({asset_ref:"uk"}),/分工/);
  for(const name of ["Bash","inspect_host","list_db_objects","list_project_files","WebFetch","call_mcp_tool"]){
    let called=false;
    const entry={metadata:{name},handler:()=>{called=true;}} as any;
    await assert.rejects(profile.invoke!(entry,{asset_ref:"uk"},{toolCallId:"child-"+name,abortSignal:new AbortController().signal,
      lakeSubagent:{id:"child",sessionId:"childSession",toolCallId:name}} as any),/分工/);
    assert.equal(called,false);
  }
  assert.equal(f.store.list("superOperations").length,0);
});

test("a cross-resource comparison can include both selected endpoints and newly assigned participants inherit its scope", async t=>{
  const f=await fixture(t);
  for(const id of ["one","two"])f.store.put("resources",id,{id,projectId:f.project.id,name:id,kind:"ssh",status:"available"});
  const selected={resourceIds:["one","two"],mentions:[],references:[]};
  const event=await f.admit("比较两台主机的配置",selected);
  const result=f.route(event,{action:"create",role_id:f.role.id,resource_ids:["one","two"],title:"比较两端"});
  f.settleRouter();
  const add=await f.admit("另一位专员也加入此任务");
  f.store.put("superRoles","role-second",{...f.role,id:"role-second",roleKey:"second",name:"另一位专员"});
  const member=f.route(add,{action:"assign",task_id:result.taskId,role_key:"second"});
  assert.deepEqual(f.worker(member.assignments[0].executionId).targetResourceIds,["one","two"]);
  assert.throws(()=>f.route(add,{action:"followup",task_id:result.taskId,role_id:f.role.id,part_key:"widen",resource_ids:["third"]}),/Only create/);
  f.settleRouter();await f.activate();
  for(const req of f.requests) assert.deepEqual(req.input.assignment.targetResourceIds,["one","two"]);
});

test("sample interval runs within the worker deadline, supports cancellation and never provides business evidence", async t => {
  const f = await fixture(t), handoff = await f.start(), worker = f.worker(handoff.taskId);
  const profile=f.host.profile(worker.sessionId)!;
  const tool=profile.tools.find(entry => entry.metadata.name==="work_wait")!;
  const wait=(seconds:unknown,signal = new AbortController().signal) =>
    tool.handler({seconds}, {abortSignal:signal} as any) as Promise<{waitedMs:number}>;
  assert.equal(tool.metadata.stopTurnOnSuccess,false);
  const before=f.store.list("superOperations");
  for(const bad of [0,-1,61,0.1,"2"]) await assert.rejects(wait(bad), /1 至 60/);
  const cancel=new AbortController();
  const pending=wait(60,cancel.signal);
  cancel.abort();
  await assert.rejects(pending,{name:"AbortError"});
  const result=await wait(1);
  assert.ok(result.waitedMs>=990);
  const goal=f.host.ledger.get(handoff.taskId);
  goal.deadlineAt=new Date(Date.now()+500).toISOString();
  f.host.ledger.save(goal);
  await assert.rejects(wait(2), /原任务期限/);
  assert.deepEqual(f.store.list("superOperations"),before);
});

test("missing recipient returns a recoverable exact-ID error before creating any task", async t => {
  const f=await fixture(t),event=await f.admit("检查当前项目文件");
  for(const roleId of ["role-checker-typo","foreign-role"]){
    if(roleId==='foreign-role')f.store.put('superRoles',roleId,{...f.role,id:roleId,projectId:'foreign'});
    assert.throws(()=>f.route(event,{action:'create',title:'检查',role_id:roleId}),(error:any)=>{
      assert.equal(error.status,404); assert.match(error.message,/specialist_not_found/);assert.match(error.message,/list_specialists/);return true;
    });
    assert.equal(f.store.list('superGoals').length,0);assert.equal(f.store.list('superDecisions').length,0);assert.equal(f.store.list('superWorkers').length,0);
  }
  f.store.put('superRoles','retired',{...f.role,id:'retired',deletedAt:'2026-11-01T00:00:00Z'});
  assert.throws(()=>f.route(event,{action:'create',title:'检查',role_id:'retired'}),(error:any)=>error.status===410);
  const result=f.route(event,{action:'create',title:'检查',role_id:f.role.id});
  assert.equal(result.roleId,f.role.id);assert.equal(f.store.list('superGoals').length,1);
});

test("snapshot verifies a corrected missing recipient against the original durable decision without editing history",async t=>{
  const f=await fixture(t),event=await f.admit("检查当前项目文件");
  const args={event_id:event.id,part_key:'work',action:'create',title:'检查',role_id:f.role.id,quote:event.payload,reason:'current human instruction'};
  const receipt=f.route(event,args),root='root-exact';
  const failed={id:'failed',type:'operation',title:'route_work',status:'failed',at:'2026-11-08T00:00:01Z',content:'记录不存在',data:{root_turn_id:root,arguments:{...args,role_id:'missing-typo'}}};
  const success={...failed,id:'success',status:'completed',at:'2026-11-08T00:00:02Z',data:{root_turn_id:root,arguments:args},content:JSON.stringify(receipt)};
  const project=(cards:any[])=>f.host.decorate({...f.store.snapshot(f.router),ai:{...f.store.view(f.router),cards}}).ai!.cards;
  const before=JSON.stringify([failed,success]),decisions=JSON.stringify(f.store.list('superDecisions'));
  const proof={kind:'corrected_missing_specialist',recoveredBy:'success'};
  assert.deepEqual((project([failed,success])[0]!.data as any).routingRecovery,proof);
  assert.deepEqual((f.host.routingView(f.router,{...f.store.view(f.router),cards:[failed,success]}).cards[0]!.data as any).routingRecovery,proof);
  assert.deepEqual((project([{...failed,content:'当前项目找不到该专员。{"code":"specialist_not_found"}'},success])[0]!.data as any).routingRecovery,proof);
  const negative=(first:any,second=success)=>assert.equal((project([first,second])[0]!.data as any).routingRecovery,undefined);
  negative({...failed,data:{...failed.data,arguments:{...args,role_id:f.role.id}}}); // Existing recipient is never inferred as a correction.
  f.store.put('superRoles','missing-typo',{...f.role,id:'missing-typo',projectId:'foreign'});negative(failed);
  f.store.delete('superRoles','missing-typo');
  for(const changed of [{title:'different'}, {quote:'different'}, {resource_ids:['other']}, {predecessor_task_id:'other'}])
    negative({...failed,data:{...failed.data,arguments:{...failed.data.arguments,...changed}}});
  negative({...failed,data:{...failed.data,root_turn_id:'other-root'}});
  negative({...failed,content:'Connection timeout'});
  negative(failed,{...success,content:JSON.stringify({...receipt,id:'uncommitted'})});
  negative(failed,{...success,data:{...success.data,arguments:{...args,reason:'not the committed decision'}}});
  assert.equal((project([success,failed])[1]!.data as any).routingRecovery,undefined);
  assert.equal((project([failed])[0]!.data as any).routingRecovery,undefined);
  assert.equal(JSON.stringify([failed,success]),before);assert.equal(JSON.stringify(f.store.list('superDecisions')),decisions);
});


test('a specialist passes 500 model calls and its stored legacy ceiling without resetting usage or acceptance',async t=>{
 const f=await fixture(t),initial=await f.start(),goal=f.host.ledger.get(initial.taskId);
 assert.equal(goal.roundLimit,undefined);
 goal.roundLimit=2;f.host.ledger.save(goal);const deadline=goal.deadlineAt;
 for(let i=0;i<503;i++)f.host.profile(f.worker().sessionId)!.beforeModel!();
 const current=f.host.ledger.get(goal.id);assert.equal(current.modelRounds,503);assert.equal(current.status,'running');assert.equal(current.roundLimit,2);
 assert.equal(current.deadlineAt,deadline);assert.equal(current.acceptanceState,'not_evaluated');
 assert.equal(f.internal.publicGoal(current).roundLimit,undefined);
 await f.finish();f.settleWorker();assert.equal(f.host.ledger.get(goal.id).acceptanceState,"not_evaluated");
 assert.equal(f.host.ledger.get(goal.id).modelRounds,503);
});

test('joint contributors continue independently beyond their combined legacy round ceilings',async t=>{
 const f=await fixture(t),other={...f.role,id:'other',roleKey:'other'};f.store.put('superRoles',other.id,other);
 const event=await f.admit('共同检查当前文件');const result=f.route(event,{action:'create',title:'共同检查',role_ids:[f.role.id,other.id]});
 f.settleRouter();await f.activate();const members=f.host.ledger.jointTask(result.taskId)!.memberIds;
 for(const id of members){const goal=f.host.ledger.get(id);goal.roundLimit=1;goal.modelRounds=501;f.host.ledger.save(goal);
  f.host.profile(goal.sessionId)!.beforeModel!();assert.equal(f.host.ledger.get(id).modelRounds,502);
  await f.read(id);await f.finish(id);f.settleWorker(id);}
 assert.equal(f.host.ledger.jointState(result.taskId)!.acceptanceState,"not_evaluated");
 assert.equal(f.host.ledger.totalModelRounds(f.host.ledger.get(result.taskId)),1004);
});

test('a legacy round-paused task waits for explicit resume, retains its ledger and still obeys deadline and cancellation',async t=>{
 const f=await fixture(t),initial=await f.start();f.settleWorker();const goal=f.host.ledger.get(initial.taskId);
 goal.status='paused';goal.summary='model_round_limit';goal.roundLimit=1;goal.modelRounds=600;f.host.ledger.save(goal);
 const before=JSON.stringify(f.host.ledger.get(goal.id)),view=f.host.decorate(f.store.snapshot(goal.sessionId));
 assert.equal(view.superagent!.task.reason,'round_limit_removed');assert.match(view.superagent!.task.summary!,/限制已取消/);
 assert.equal(JSON.stringify(f.host.ledger.get(goal.id)),before);await f.activate();assert.equal(f.worker().state,'parked');
 await f.host.control(goal.sessionId,{command:'resume',goalId:goal.id,revision:f.host.ledger.get(goal.id).revision});await f.activate();
 f.host.profile(goal.sessionId)!.beforeModel!();assert.equal(f.host.ledger.get(goal.id).modelRounds,601);
 const expired=f.host.ledger.get(goal.id);expired.deadlineAt=new Date(Date.now()-1000).toISOString();f.host.ledger.save(expired);
 assert.throws(()=>f.host.profile(goal.sessionId)!.beforeModel!(),/deadline/);
 assert.equal(f.host.ledger.get(goal.id).summary,'deadline_reached');
 await f.host.control(goal.sessionId,{command:'cancel',goalId:goal.id,revision:f.host.ledger.get(goal.id).revision});
 assert.equal(f.host.ledger.get(goal.id).status,'cancelled');assert.equal(f.host.ledger.get(goal.id).modelRounds,601);
});


test('Pilot retains pre-task and task usage beyond 500 without imposing a model-call ceiling',async t=>{
 const f=await fixture(t);await f.admit('直接检查当前项目文件');f.agents.isRunning=()=>true;
 const profile=f.host.profile(f.router)!;
 for(let i=0;i<501;i++)profile.beforeModel!();
 const actor=f.internal.pilotActors.get(f.router);assert.equal(actor.preTaskModelRounds,501);assert.equal(f.store.list('superGoals').length,0);
 f.internal.ensurePilotTask(actor);const goal=f.host.ledger.get(actor.taskId);
 assert.equal(goal.modelRounds,501);assert.equal(goal.roundLimit,undefined);assert.equal(goal.status,'running');
 for(let i=0;i<3;i++)profile.beforeModel!();
 assert.equal(f.host.ledger.get(goal.id).modelRounds,504);assert.equal(f.host.ledger.get(goal.id).acceptanceState,'not_evaluated');
});
