import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LakeData } from "../dist/adapters/storage/data.js";
import { LakeDatabase } from "../dist/adapters/storage/database.js";

async function fixture(body) {
  const root = await mkdtemp(join(tmpdir(), "lake-ts-workflow-"));
  const data = new LakeData(await LakeDatabase.open(root));
  try { await data.request("lake.add", { name: "测试湖" }); await body(data); }
  finally { data.close(); await rm(root, { recursive: true, force: true }); }
}

test("v1 snapshots survive definition edits and require valid state transitions", () => fixture(async data => {
  const definition = await data.request("workflow.save", { lake: "测试湖", spec: { name: "巡检", execution_mode: "fixed", steps: [{ id: "check", name: "检查", kind: "ssh_check", resource: "主机", check: "uptime" }] } });
  const run = await data.request("workflow.create_run", { definition_id: definition.id });
  await data.request("workflow.amend", { id: definition.id, spec: { ...definition.spec, name: "新版巡检" } });
  assert.equal((await data.request("workflow.status", { id: run.id })).spec.name, "巡检");
  await data.request("workflow.run_status", { id: run.id, status: "running" });
  await data.request("workflow.node_status", { id: run.id, node_id: "check", to: "running" });
  await data.request("workflow.node_status", { id: run.id, node_id: "check", to: "completed", stdout: "fixture" });
  await assert.rejects(data.request("workflow.node_status", { id: run.id, node_id: "check", to: "running" }), /状态已变化/u);
  await data.request("workflow.run_status", { id: run.id, status: "completed" });
  assert.equal((await data.request("workflow.status", { id: run.id })).steps[0].stdout, "fixture");
}));

test("v2 revisions, node admission and ordered events use transactional comparisons", () => fixture(async data => {
  const spec = { version: 2, name: "巡检 v2", nodes: [{ id: "check", kind: "ssh_check", target: { type: "string", literal: "主机" }, check: "uptime" }] };
  const definition = await data.request("workflow.v2.save", { lake: "测试湖", spec });
  await data.request("workflow.v2.amend", { id: definition.id, expected_revision: 1, spec: { ...spec, name: "新版" } });
  await assert.rejects(data.request("workflow.v2.amend", { id: definition.id, expected_revision: 1, spec }), /其他编辑/u);
  const run = await data.request("workflow.v2.create_run", { definition_id: definition.id });
  assert.equal(run.revision, 2);
  await data.request("workflow.v2.node_status", { id: run.id, node_id: "check", from: "pending", to: "waiting_approval" });
  await assert.rejects(data.request("workflow.v2.node_status", { id: run.id, node_id: "check", from: "pending", to: "running" }), /状态已变化/u);
  await data.request("workflow.v2.node_status", { id: run.id, node_id: "check", from: "waiting_approval", to: "running", approval: { decision: "approved" } });
  await data.request("workflow.v2.node_status", { id: run.id, node_id: "check", from: "running", to: "unknown", error_code: "connection_lost" });
  const events = await data.request("workflow.v2.events", { id: run.id });
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4]);
  assert.equal((await data.request("workflow.v2.status", { id: run.id })).nodes[0].status, "unknown");
}));

test("workflow dependency cycles and references outside dependencies are rejected", () => fixture(async data => {
  await assert.rejects(data.request("workflow.save", { lake: "测试湖", spec: { name: "循环", steps: [{ id: "a", name: "a", kind: "ssh_check", resource: "主机", check: "uptime", depends_on: ["b"] }, { id: "b", name: "b", kind: "ssh_check", resource: "主机", check: "uptime", depends_on: ["a"] }] } }), /存在环/u);
  await assert.rejects(data.request("workflow.v2.save", { lake: "测试湖", spec: { version: 2, name: "引用越界", nodes: [{ id: "a", kind: "ssh_check", target: { type: "string", literal: "主机" }, check: "uptime" }, { id: "b", kind: "ssh_command", target: { type: "string", ref: { node: "a", type: "string" } }, command: { type: "string", literal: "true" } }] } }), /直接依赖/u);
}));
