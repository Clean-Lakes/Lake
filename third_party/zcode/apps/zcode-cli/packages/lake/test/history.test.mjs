import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLakeRuntime } from "../dist/contract.js";
import { sanitizeReport } from "../dist/domain/report.js";
import { sanitizeSnapshot, UI_CATALOG } from "../dist/domain/ui.js";

async function fixture(body) {
  const root = await mkdtemp(join(tmpdir(), "lake-ts-history-")), runtime = await createLakeRuntime({ root });
  const call = (method, params = {}) => runtime.dispatch({ method, params });
  try { await call("lake.add", { name: "fixture" }); const conversation = await call("conversation.create", { lake: "fixture" }); await body(call, conversation.id); }
  finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}
test("event schema rejects raw arguments and secret fields; archived turn admission rolls back", () => fixture(async (call, id) => {
  for (const payload of [{ api_key: "synthetic" }, { preview: "fixture", unexpected: {} }, { preview: 123 }]) await assert.rejects(call("conversation.append_event", { id, kind: "assistant_progress", payload }));
  await assert.rejects(call("conversation.append_event", { id, kind: "unknown", payload: {} }));
  const event = await call("conversation.append_event", { id, kind: "assistant_progress", payload: { preview: "Authorization: Bearer synthetic" } });
  assert.equal(event.payload.preview, "[redacted]");
  await call("conversation.archive", { id });
  await assert.rejects(call("conversation.begin_turn", { id, prompt: "fixture" }));
  await call("conversation.restore", { id });
  assert.equal((await call("conversation.show", { id })).turns.length, 0);
}));
test("task checkpoint provenance cannot turn assistant statements into user goals or lose coverage", () => fixture(async (call, id) => {
  const turn = await call("conversation.begin_turn", { id, prompt: "必须保留现在的前端" });
  const assistant = await call("conversation.finish_turn", { id, turn_id: turn.id, answer: "already deployed" });
  const sources = [turn.event.sequence, assistant.sequence], p = { id, through_seq: assistant.sequence, text: "fixture context", token_estimate: 5, source_event_ids: sources };
  await assert.rejects(call("conversation.save_summary", { ...p, task_state: { version: 1, goals: [{ text: "already deployed", source_event_ids: [assistant.sequence] }] } }));
  await call("conversation.save_summary", { ...p, task_state: { version: 1, constraints: [{ text: "保留现在的前端", source_event_ids: [turn.event.sequence] }], reported_results: [{ text: "assistant said already deployed", source_event_ids: [assistant.sequence] }] } });
  assert.equal((await call("conversation.summary", { id })).task_state.constraints[0].text, "保留现在的前端");
  await assert.rejects(call("conversation.save_summary", { ...p, source_event_ids: [assistant.sequence] }));
}));
test("execution references are conversation-local and preserve checked output projection", () => fixture(async (call, id) => {
  const record = { id: "fixture-exec", actor: "user", scope_id: "fixture-project", session_id: "fixture-shell", status: "completed", command: "printf fixture", stdout: "password=synthetic", stderr: "", error: "", exit_code: 0, duration_ms: 3, target: "local", working_directory: "/fixture", truncated: false };
  const saved = await call("conversation.append_execution", { id, record });
  assert.equal(saved.record.stdout, "[redacted]");
  assert.deepEqual(await call("conversation.execution", { id, sequence: saved.record.sequence }), saved.record);
  const other = await call("conversation.create", { lake: "fixture" });
  await assert.rejects(call("conversation.execution", { id: other.id, sequence: saved.record.sequence }));
}));
test("report schemas reject executable layout and omitted findings and canonicalize structural IDs", () => {
  const report = { title: "Fixture", summary: "Synthetic result", tone: "warning", findings: [{ title: "Warning", detail: "Needs review", tone: "warning" }], flow: { nodes: [{ id: "source", label: "First", status: "completed" }, { id: "target", label: "Second", status: "pending" }], edges: [{ from: "source", to: "target" }] } };
  const clean = sanitizeReport(report); assert.equal(clean.flow.nodes[0].id, "node-1"); assert.equal(clean.flow.edges[0].to, "node-2"); assert.equal(report.flow.nodes[0].id, "source");
  assert.throws(() => sanitizeReport({ ...report, ui: { root: "layout", elements: { layout: { type: "Flow", props: {} } } } }), /全部数据/u);
  assert.throws(() => sanitizeReport({ ...report, script: "fixture" }));
  assert.throws(() => sanitizeReport({ ...report, flow: { ...report.flow, edges: [{ from: "source", to: "target" }, { from: "target", to: "source" }] } }));
});
test("A2UI validation preserves allowed components and rejects prototype paths and executable actions", () => {
  const ui = { surfaceId: "fixture", catalogId: UI_CATALOG, revision: 1, components: [{ id: "root", component: "Column", children: ["text"] }, { id: "text", component: "Text", text: { path: "/label" } }], data: { label: "Fixture", password: "synthetic" } };
  const clean = sanitizeSnapshot(ui); assert.equal(clean.data.password, "[redacted]"); assert.equal(ui.data.password, "synthetic");
  assert.throws(() => sanitizeSnapshot({ ...ui, components: [{ id: "root", component: "Text", text: { path: "/__proto__/label" } }] }));
  assert.throws(() => sanitizeSnapshot({ ...ui, components: [{ id: "root", component: "Button", label: "Fixture", action: { event: { name: "execute" } } }] }));
  assert.throws(() => sanitizeSnapshot({ ...ui, components: [{ id: "root", component: "Column", children: ["root"] }] }));
});
