const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { buildRouterContext, projectRouterHistory } = require("./router-context.ts");
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const when = (minute) => `2026-11-05T12:${String(minute).padStart(2, "0")}:00.000Z`;
const event = (extra = {}) => ({ id: "event-retry", messageId: "retry", projectId: "project", sessionId: "channel", payload: "再试试", receivedAt: when(10), revision: 1, hash: "e".repeat(64), preferredRoleId: "ops", ...extra });
const task = (extra = {}) => ({ taskId: "original-task", projectId: "project", roleId: "ops", sessionId: "worker", title: "检查测试服务器", state: "waiting_user", acceptanceState: "insufficient", revision: 10, hash: "a".repeat(64), updatedAt: when(2), pendingApproval: false, unresolvedOperations: 0, resourceIds: ["host"], ...extra });
const message = (id, role, text, minute, extra = {}) => ({ id, role, text, createdAt: when(minute), projectId: "project", sessionId: "channel", ...extra });
const source = (extra = {}) => ({ projectId: "project", events: [event()], now: when(10), adapters: { ssh: true, extensions: false },
  tasks: [task()], resources: [{ id: "host", name: "测试服务器", projectId: "project", kind: "ssh", status: "available", revision: 2 }],
  messages: [message("ask", "user", "分析测试服务器的情况", 1), message("report", "assistant", "之前未能读取这台服务器的指标。", 3, { taskId: "original-task", kind: "report" }), message("retry", "user", "再试试", 10)], ...extra });
function parse(result) {
  const lines = result.input.split("\n");
  return { events: JSON.parse(lines[1]), tasks: JSON.parse(lines[3]), context: JSON.parse(lines[5]) };
}

test("an empty specialist catalog still carries default delegation without removing shared capabilities", () => {
  const result = buildRouterContext(source({ specialists: [], agentTools: ["Bash", "Agent"] }));
  const value = parse(result).context;
  assert.deepEqual(value.specialists.items, []);
  assert.deepEqual(value.coordinationPolicy, {
    resourceWork: "delegate_by_default", missingSpecialist: "create_and_delegate",
    existingSpecialist: "reuse_suitable_stable_role", pilotDirectExecution: "explicit_user_request",
  });
  assert.equal(value.capabilities.rolesShareTools, true);
  assert.ok(value.capabilities.workerTools.includes("Bash"));
  assert.ok(value.capabilities.workerTools.includes("Agent"));
  assert.ok(Buffer.byteLength(result.input) <= 16384);
});

test("current MySQL capability names real fixed tools and counts only configured MySQL resources", () => {
  const value=parse(buildRouterContext(source({adapters:{ssh:true,extensions:false,mysql:true},resources:[
    {id:'mysql',projectId:'project',name:'MySQL',kind:'database',driver:'mysql',status:'available',revision:1},
    {id:'postgres',projectId:'project',name:'PostgreSQL',kind:'database',driver:'postgres',status:'available',revision:1},
    {id:'missing',projectId:'project',name:'Missing',kind:'database',driver:'mysql',status:'unavailable',revision:1}
  ]}))).context.capabilities;
  assert.deepEqual(value.mysql,{adapterRegistered:true,configuredResources:1,rawSQL:false});
  for(const name of ['list_db_objects','db_table_ddl','read_db_table'])assert.ok(value.workerTools.includes(name));
  assert.ok(!value.workerTools.includes('execute_sql'));
});

test("retry context includes the delivered report, exact original task and current SSH capability", () => {
  const result = buildRouterContext(source({ tasks: [task({ blockers: [{ detail: "当时未提供服务器读取工具", recordUpdatedAt: when(2), capabilityRevision: "old-runtime" }] }), task({ taskId: "newer-unrelated", title: "另一个检查", updatedAt: when(9), resourceIds: [] })] }));
  const value = parse(result);
  assert.equal(value.events[0].text, "再试试");
  assert.equal(value.context.focus[0].task.id, "original-task");
  assert.equal(value.context.focus[0].task.hash, "a".repeat(64));
  assert.equal(value.context.focus[0].basis, "recent_dialogue");
  assert.ok(value.context.dialogue.some((row) => row.id === "report" && row.text.includes("之前未能读取")));
  assert.ok(!value.context.dialogue.some((row) => row.id === "retry"));
  assert.ok(value.context.capabilities.workerTools.includes("inspect_host"));
  assert.equal(value.context.capabilities.ssh.configuredResources, 1);
  assert.equal(value.tasks[0].historicalBlockers[0].freshness, "stale_capability_revision");
  assert.equal(value.tasks[0].historicalBlockers[0].observedAt, null, "record update time must not become a fabricated observation");
  assert.equal(value.tasks[0].state, "waiting_user");
  assert.equal(value.tasks[0].pendingApproval, false, "task status is not an approval requirement");
  assert.equal(result.complete.has("event-retry"), true);
});

test("focus carries current lifecycle and reported outcome without promoting historical acceptance into a routing gate", () => {
  for (const state of ["queued", "running", "waiting_user", "waiting_external", "paused", "blocked", "completed", "failed", "cancelled"]) {
    for (const acceptanceState of ["insufficient", "pass"]) {
      const reportedOutcome = state === "completed" ? "partial" : undefined;
      const original = source({ tasks: [task({ state, acceptanceState, reportedOutcome, revision: 12, updatedAt: when(8),
        pendingApproval: state === "waiting_user", unresolvedOperations: state === "blocked" ? 1 : 0 })] });
      const before = JSON.stringify(original), value = parse(buildRouterContext(original));
      assert.deepEqual(value.context.focus[0], {
        task: { kind: "task", id: "original-task", revision: 12, hash: "a".repeat(64) },
        roleId: "ops", title: "检查测试服务器", state, ...(reportedOutcome && {reportedOutcome}), archived: false, updatedAt: when(8), basis: "recent_dialogue",
      });
      assert.equal(value.tasks[0].reportedOutcome, reportedOutcome);
      assert.ok(!Object.hasOwn(value.tasks[0], "acceptanceState"));
      assert.ok(!Object.hasOwn(value.context.focus[0], "acceptanceState"));
      assert.equal(value.tasks[0].pendingApproval, state === "waiting_user");
      assert.equal(value.tasks[0].unresolvedOperations, state === "blocked" ? 1 : 0);
      assert.equal(JSON.stringify(original), before, "routing context does not reopen tasks or alter acceptance");
    }
  }
});

test("a new check sees the exact completed task without rewriting old queue prose or inferring IDs from it", () => {
  const oldQueueText = "目前还在排队，旧记录任务是 retired-task，专员是 retired-role。";
  const original = source({ events: [event({ payload: "重新查一下这台服务器" })],
    tasks: [task({ state: "completed", acceptanceState: "pass", reportedOutcome: "completed", revision: 11, updatedAt: when(8), summary: "磁盘使用率 18%。" })],
    messages: [...source().messages, message("old-queue", "assistant", oldQueueText, 2)] });
  const before = JSON.stringify(original), result = buildRouterContext(original), value = parse(result);
  const historical = value.context.dialogue.find((row) => row.id === "old-queue");
  assert.equal(historical.text, oldQueueText);
  assert.equal(historical.historical, true);
  assert.equal(historical.at, when(2));
  assert.equal(value.context.focus[0].task.id, "original-task");
  assert.equal(value.context.focus[0].roleId, "ops");
  assert.equal(value.context.focus[0].state, "completed");
  assert.equal(value.context.focus[0].reportedOutcome, "completed");
  assert.ok(!Object.hasOwn(value.context.focus[0], "acceptanceState"));
  assert.ok(!JSON.stringify(value.context.focus).includes("retired-"));
  assert.deepEqual(parse(buildRouterContext({ ...original, tasks: [] })).context.focus, [], "historical IDs cannot manufacture current task references");
  const request = projectRouterHistory({ messages: [{ role: "user", content: result.input }] }, [], new Set(), result.input);
  const providerContext = JSON.parse(request.messages[0].content.split("\n")[5]);
  assert.deepEqual(providerContext.focus, value.context.focus, "current lifecycle and references reach the provider input");
  assert.equal(JSON.stringify(original), before, "old conversation remains an unchanged historical record");
});

test("conversation workset is scoped to the admitted channel and current project", () => {
  const value = parse(buildRouterContext(source({ messages: [...source().messages,
    message("foreign-channel", "assistant", "OTHER_CHANNEL_PRIVATE", 9, { sessionId: "other-channel" }),
    message("foreign-project", "assistant", "OTHER_PROJECT_PRIVATE", 9, { projectId: "other-project" }),
    message("mechanical", "assistant", "专员已保留当前进度；尚未取得全部验收证据。", 9),
    message("quoted-by-user", "user", "专员已保留当前进度；尚未取得全部验收证据。", 8)],
    tasks: [task(), task({ taskId: "foreign-task", projectId: "other-project", title: "OTHER_PROJECT_PRIVATE" }), task({ taskId: "other-role", roleId: "db", title: "OTHER_ROLE_TASK" })],
    resources: [...source().resources, { id: "foreign-host", name: "OTHER_PROJECT_PRIVATE", projectId: "other-project", kind: "ssh", status: "available", revision: 1 }] })));
  assert.ok(!JSON.stringify(value).includes("OTHER_PROJECT_PRIVATE"));
  assert.ok(!JSON.stringify(value).includes("OTHER_CHANNEL_PRIVATE"));
  assert.ok(!JSON.stringify(value).includes("OTHER_ROLE_TASK"));
  assert.ok(!value.context.dialogue.some((row) => row.id === "mechanical"));
  assert.ok(value.context.dialogue.some((row) => row.id === "quoted-by-user"), "user quotes are not rewritten as boilerplate");
  assert.equal(value.context.capabilities.ssh.configuredResources, 1);
});

test("only the four recent turns are carried; pending effects remain distinct from old prose", () => {
  const messages = Array.from({ length: 7 }, (_, index) => [message(`u${index}`, "user", `问题${index}`, index * 2), message(`a${index}`, "assistant", `结果${index}`, index * 2 + 1, { taskId: "original-task", kind: "report" })]).flat();
  const value = parse(buildRouterContext(source({ events: [event({ receivedAt: when(20) })], messages, tasks: [task({ state: "blocked", pendingApproval: true, unresolvedOperations: 1 })] })));
  assert.deepEqual(value.context.dialogue.filter((row) => row.role === "user").map((row) => row.id), ["u3", "u4", "u5", "u6"]);
  assert.equal(value.tasks[0].pendingApproval, true);
  assert.equal(value.tasks[0].unresolvedOperations, 1);
});

test("bounded UTF-8 request clips narrative without changing identities or source records", () => {
  const original = source({ events: [event({ payload: "服务器🌊".repeat(8000) })], messages: Array.from({ length: 12 }, (_, index) => message(`m${index}`, index % 2 ? "assistant" : "user", "检查🌊".repeat(1500), index)),
    tasks: Array.from({ length: 30 }, (_, index) => task({ taskId: `task${index}`, state: "completed", reportedOutcome: index % 2 ? "partial" : "completed", title: "业务标题🌊".repeat(50), summary: "说明🌊".repeat(1000), updatedAt: when(index) })) });
  const before = JSON.stringify(original);
  const result = buildRouterContext(original), value = parse(result);
  assert.ok(Buffer.byteLength(result.input) <= 16384);
  assert.ok(!result.input.includes("�"));
  assert.equal(value.events[0].id, "event-retry");
  assert.equal(value.events[0].hash, "e".repeat(64));
  assert.equal(value.events[0].clipped, true);
  assert.equal(result.complete.size, 0);
  assert.equal(value.context.truncated, true);
  assert.ok(value.context.focus.length > 0);
  for (const focus of value.context.focus) {
    const current = original.tasks.find((row) => row.taskId === focus.task.id);
    assert.ok(current);
    assert.equal(focus.task.revision, current.revision);
    assert.equal(focus.task.hash, current.hash);
    assert.equal(focus.state, current.state);
    assert.equal(focus.reportedOutcome, current.reportedOutcome);
    assert.ok(!Object.hasOwn(focus, "acceptanceState"));
    assert.equal(focus.updatedAt, current.updatedAt);
  }
  assert.equal(JSON.stringify(original), before, "workset projection cannot mutate the original archive");
});

test("adapter and catalog revision changes are visible independently of historical task status", () => {
  const absent = buildRouterContext(source({ adapters: { ssh: false, extensions: false } }));
  const present = buildRouterContext(source());
  assert.notEqual(absent.capabilityRevision, present.capabilityRevision);
  assert.ok(!parse(absent).context.capabilities.workerTools.includes("inspect_host"));
  assert.equal(parse(present).tasks[0].state, "waiting_user");
  const edited = buildRouterContext(source({ resources: [{ ...source().resources[0], revision: 3 }] }));
  assert.notEqual(edited.capabilityRevision, present.capabilityRevision);
});

test("provider projection removes only complete admitted history and keeps the new dialogue workset", () => {
  const old = "old consumed host envelope", input = buildRouterContext(source()).input;
  const archives = [{ hash: hash(old), eventIds: ["old-event"] }];
  const messages = [{ role: "system", content: "policy" }, { role: "user", content: old },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "read-old" }] }, { role: "tool", content: [{ type: "tool-result", toolCallId: "read-old", result: "old evidence" }] },
    { role: "assistant", content: "old boilerplate" }, { role: "user", content: input },
    { role: "assistant", tool_calls: [{ id: "current", function: { name: "route_work" } }] }, { role: "tool", tool_call_id: "current", content: "current result" }];
  const request = { messages }, before = JSON.stringify(request);
  const projected = projectRouterHistory(request, archives, new Set(["old-event"]), input);
  assert.equal(projected.messages.length, 4);
  assert.ok(projected.messages.some((row) => row.content === input));
  assert.ok(JSON.stringify(projected).includes("之前未能读取这台服务器"));
  assert.ok(JSON.stringify(projected).includes("inspect_host"));
  assert.equal(JSON.stringify(request), before);
  assert.equal(projectRouterHistory(request, archives, new Set(), input).messages.length, messages.length);
  assert.equal(projectRouterHistory(request, archives, new Set(["old-event"]), "missing current anchor"), request);
  const missingResult = { messages: messages.filter((row) => row.role !== "tool" || row.tool_call_id) };
  assert.equal(projectRouterHistory(missingResult, archives, new Set(["old-event"]), input).messages.length, missingResult.messages.length);
});

test('current specialist catalog keeps exact IDs, filters scope/deletion and remains bounded',()=>{
 const specialists=Array.from({length:60},(_,i)=>({id:`role-${i}-${'a'.repeat(64)}`,projectId:'project',name:'专员'.repeat(200),revision:2}));
 specialists.unshift({id:'foreign',projectId:'other',name:'foreign',revision:1},{id:'deleted',projectId:'project',name:'old',revision:1,deletedAt:when(1)});
 const original=source({specialists}),before=JSON.stringify(original),result=buildRouterContext(original),value=parse(result);
 assert.ok(Buffer.byteLength(result.input)<=16384);assert.ok(value.context.specialists.hasMore);
 assert.ok(value.context.specialists.items.length>0&&value.context.specialists.items.length<=20);
 for(const item of value.context.specialists.items){assert.ok(specialists.some(role=>role.id===item.id&&role.projectId==='project'&&!role.deletedAt));assert.equal(item.revision,2);}
 assert.match(value.context.specialists.meaning,/list_specialists/);assert.equal(JSON.stringify(original),before);
 const small=buildRouterContext({...original,maxBytes:4200});assert.ok(Buffer.byteLength(small.input)<=4200);assert.ok(parse(small).context.specialists.hasMore);
});
