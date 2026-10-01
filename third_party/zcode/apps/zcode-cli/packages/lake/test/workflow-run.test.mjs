import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { LakeApplication } from "../dist/app/runtime.js";
import { LakeData } from "../dist/adapters/storage/data.js";
import { LakeDatabase, newID } from "../dist/adapters/storage/database.js";
import { resolveValue } from "../dist/domain/workflow.js";

async function fixture(body) {
  const root = await mkdtemp(join(tmpdir(), "lake-ts-engine-")), data = new LakeData(await LakeDatabase.open(root)), calls = [], events = [];
  let execute = async () => ({ status: "completed", stdout: "fixture", stderr: "", exit_code: 0, duration_ms: 1 });
  const runtime = new LakeApplication({ data, id: newID, options: { root }, settings: { request: async () => ({}) }, digest: s => createHash("sha256").update(s).digest("hex"), execution: { request: async (method, params, signal) => { calls.push({ method, params }); return execute(params, signal); }, close: async () => {} }, emit: event => { events.push(event); if (event.type === "approval") void runtime.dispatch({ method: "approval.respond", params: { id: event.approval_id, approved: true } }); } });
  try {
    await data.request("lake.add", { name: "fixture" });
    const host = await data.request("res.add", { lake: "fixture", name: "host", spec: { ssh: { host: "fixture.invalid", username: "fixture", port: 22 } }, credential_ref: "file:ssh/fixture" });
    await data.request("res.authorize", { resource: host.id, allow: true });
    await data.request("permissions.set", { key: "ssh-read", enabled: false });
    await body({ runtime, data, calls, events, root, execute: fn => { execute = fn; } });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}
const literal = value => ({ type: "string", literal: value });
test("workflow execution preserves dependency order, audit and exact node consent", () => fixture(async ({ runtime, data, calls, events }) => {
  const spec = { version: 2, name: "fixture", nodes: [{ id: "check", kind: "ssh_check", target: literal("host"), check: "uptime" }, { id: "write", kind: "ssh_command", depends_on: ["check"], target: literal("host"), command: literal("printf fixture") }] };
  const definition = await data.request("workflow.v2.save", { lake: "fixture", spec });
  const run = await runtime.dispatch({ method: "workflow.v2.execute", id: "engine", params: { definition_id: definition.id } });
  assert.equal(run.status, "completed"); assert.deepEqual(calls.map(call => call.params.command), ["uptime", "printf fixture"]);
  assert.equal(events.filter(event => event.type === "approval").length, 2);
  assert.equal(run.nodes[1].approval.outcome, "allow");
  assert.deepEqual((await data.request("journal.list", { run_id: run.id })).filter(row => row.tool === "lake_ssh_command").reverse().map(row => row.event), ["requested", "proposed", "approved", "started", "completed"]);
  assert.deepEqual((await runtime.dispatch({ method: "workflow.v2.execute", id: "engine", params: { definition_id: definition.id } })).id, run.id); assert.equal(calls.length, 2);
}));
test("failed dependency skips success nodes and admits recovery conditions", () => fixture(async ({ runtime, data, calls, execute }) => {
  execute(async p => ({ status: p.command === "uptime" ? "failed" : "completed", stdout: "", stderr: "", exit_code: p.command === "uptime" ? 1 : 0, duration_ms: 1 }));
  const definition = await data.request("workflow.save", { lake: "fixture", spec: { name: "recovery", steps: [{ id: "check", name: "check", kind: "ssh_check", resource: "host", check: "uptime" }, { id: "skip", name: "skip", kind: "ssh_check", resource: "host", check: "hostname", depends_on: ["check"] }, { id: "recover", name: "recover", kind: "ssh_check", resource: "host", check: "disk", when: "any_failure", depends_on: ["check"] }] } });
  const run = await runtime.dispatch({ method: "workflow.execute", params: { definition_id: definition.id } });
  assert.equal(run.status, "failed"); assert.deepEqual(calls.map(call => call.params.command), ["uptime", "df -hP"]); assert.equal(run.steps.find(step => step.step_id === "skip").status, "skipped");
}));
test("unknown write requires explicit recovery and rejects changed frozen resources", () => fixture(async ({ runtime, data, calls, execute }) => {
  execute(async () => ({ status: "unknown", stdout: "", stderr: "", exit_code: 255, duration_ms: 1 }));
  const definition = await data.request("workflow.v2.save", { lake: "fixture", spec: { version: 2, name: "uncertain", nodes: [{ id: "write", kind: "ssh_command", target: literal("host"), command: literal("printf fixture") }] } });
  const run = await runtime.dispatch({ method: "workflow.v2.execute", params: { definition_id: definition.id } }); assert.equal(run.nodes[0].status, "unknown");
  await assert.rejects(runtime.dispatch({ method: "workflow.v2.execute", params: { run_id: run.id } }), /retry_writes/u); assert.equal(calls.length, 1);
  await data.request("res.add", { lake: "fixture", name: "new-host", spec: { ssh: { host: "new.invalid", username: "fixture" } } });
  await assert.rejects(runtime.dispatch({ method: "workflow.v2.execute", params: { run_id: run.id, retry_writes: true } }), /资源范围已变化/u); assert.equal(calls.length, 1);
}));
test("typed references reject prototype names and noncanonical array offsets", () => {
  for (const path of ["/constructor", "/__proto__", "/0.0", "/00"]) assert.throws(() => resolveValue({ type: "string", ref: { node: "source", type: "string", path } }, new Map([["source", ["fixture"]]])));
  assert.equal(resolveValue({ type: "string", ref: { node: "source", type: "string", path: "/0" } }, new Map([["source", ["fixture"]]])), "fixture");
});

async function scheduled(data, grant) {
  const definition=await data.request("workflow.v2.save", {lake:"fixture",spec:{version:2,name:grant?"granted":"ungranted",nodes:[{id:"write",kind:"ssh_command",target:literal("host"),command:literal("printf fixture")} ]}});
  const now=Date.now();const schedule=await data.request("schedule.create",{workflow_id:definition.id,kind:"once",expression:new Date(now-1000).toISOString(),timezone:"UTC",now_ms:now-2000});
  if(grant) await data.request("schedule.grant",{id:schedule.id,node_id:"write",resource:"fixture/host",command_sha256:createHash("sha256").update("printf fixture").digest("hex"),expires_ms:now+60000,max_runs:1});
  return schedule;
}
test("unattended schedule waits without a grant and consumes exact consent once",()=>fixture(async({runtime,data,calls,events})=>{
  const pending=await scheduled(data,false);await runtime.dispatch({method:"schedule.poll",params:{}});
  assert.equal((await data.request("schedule.runs",{id:pending.id}))[0].status,"waiting_approval");assert.equal(calls.length,0);assert.equal(events.filter(e=>e.type==="approval").length,0);
  const admitted=await scheduled(data,true);await Promise.all([runtime.dispatch({method:"schedule.poll",params:{}}),runtime.dispatch({method:"schedule.poll",params:{}})]);
  const run=(await data.request("schedule.runs",{id:admitted.id}))[0];assert.equal(run.status,"completed");assert(run.workflow_run_id);assert.equal(calls.length,1);
  await runtime.dispatch({method:"schedule.poll",params:{}});assert.equal(calls.length,1);
}));
test("revoked scheduled host cannot dispatch a previously granted command",()=>fixture(async({runtime,data,calls})=>{
  const schedule=await scheduled(data,true);await data.request("res.authorize",{resource:"fixture/host",allow:false});await runtime.dispatch({method:"schedule.poll",params:{}});
  assert.equal(calls.length,0);assert.equal((await data.request("schedule.runs",{id:schedule.id}))[0].status,"waiting_approval");
}));
