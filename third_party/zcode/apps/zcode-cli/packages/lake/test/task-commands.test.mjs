import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LakeApplication } from "../dist/app/runtime.js";
import { LakeData } from "../dist/adapters/storage/data.js";
import { LakeDatabase, newID } from "../dist/adapters/storage/database.js";
import { OperationsTransport } from "../dist/adapters/execution/transport.js";
import { FileVault } from "../dist/adapters/vault.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lake-ts-task-command-")), path = join(root, "project"); await mkdir(path);
  const data = new LakeData(await LakeDatabase.open(join(root, "data"))), events = [], listeners = [];
  const app = new LakeApplication({ data, settings: { request: async () => ({}) }, execution: new OperationsTransport(new FileVault(join(root, "data"))), options: {}, id: newID, digest: value => createHash("sha256").update(value).digest("hex"),
    emit: event => { events.push(event); listeners.forEach(listener => listener(event)); },
    agent: { run: async (_input, tools, signal) => JSON.stringify(await tools.find(tool => tool.name === "lake_code_terminal_run").call({ command: "printf x >> once.txt" }, signal)) },
  });
  const call = (method, params = {}, id) => app.dispatch({ method, params, id });
  await call("lake.add", { name: "fixture" }); const project = await call("code.add", { lake: "fixture", path }), conversation = await call("conversation.create", { lake: "fixture" });
  await call("code.bind", { id: conversation.id, project_id: project.id });
  const proposal = async () => { for (let i = 0; i < 100; i++) { const event = events.find(event => event.type === "command_proposed"); if (event) return event; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("proposal missing"); };
  return { call, root, path: project.path, conversation, project, events, listeners, proposal, close: async () => { await app.close(); await rm(root, { recursive: true, force: true }); } };
}
test("live task proposal executes exactly once and persists execution before model continuation", async () => {
  const f = await fixture();
  try {
    const turn = f.call("conversation.ask", { id: f.conversation.id, prompt: "fixture command" }, "fixture-turn");
    const proposed = await f.proposal();
    await assert.rejects(f.call("task.run", { id: f.conversation.id, command: "printf forbidden" }));
    const params = { id: proposed.proposal_id };
    const [record, duplicate] = await Promise.all([f.call("task.proposed_run", params, "fixture-click"), f.call("task.proposed_run", params, "fixture-click")]);
    assert.deepEqual(record, duplicate); assert.equal(record.status, "completed");
    assert.equal(await readFile(join(f.path, "once.txt"), "utf8"), "x");
    const answer = JSON.parse((await turn).answer); assert.equal(answer.sequence, record.sequence);
    assert(!f.events.some(event => event.type === "approval"));
    const history = await f.call("conversation.show", { id: f.conversation.id });
    const kinds = history.events.map(event => event.kind); assert(kinds.indexOf("execution_started") < kinds.indexOf("execution_finished")); assert(kinds.indexOf("execution_finished") < kinds.indexOf("answer_finished"));
    await assert.rejects(f.call("task.proposed_run", params));
  } finally { await f.close(); }
});
test("task handoff accepts only fresh user execution from the same conversation workspace", async () => {
  const f = await fixture();
  f.listeners.push(event => { if (event.type === "approval") void f.call("approval.respond", { id: event.approval_id, approved: true }); });
  try {
    const turn = f.call("conversation.ask", { id: f.conversation.id, prompt: "fixture handoff" }, "fixture-handoff");
    const proposed = await f.proposal(); await f.call("task.take", { id: proposed.proposal_id });
    const manual = await f.call("task.run", { id: f.conversation.id, command: "printf user-result" });
    assert.equal(manual.actor, "user"); assert.equal(manual.stdout, "user-result");
    await assert.rejects(f.call("task.return", { id: proposed.proposal_id, sequence: proposed.after_sequence }));
    await f.call("task.return", { id: proposed.proposal_id, sequence: manual.sequence });
    assert.equal(JSON.parse((await turn).answer).stdout, "user-result");
    await assert.rejects(readFile(join(f.path, "once.txt")));
    const status = await f.call("task.status", { id: f.conversation.id }); assert.equal(status.scope_id, f.project.id);
  } finally { await f.close(); }
});
test("cancelled and rebound proposals cannot execute or revive the original operation", async () => {
  const f = await fixture();
  try {
    const turn = f.call("conversation.ask", { id: f.conversation.id, prompt: "fixture scope" }, "fixture-scope"); void turn.catch(() => {});
    const proposed = await f.proposal();
    await f.call("code.bind", { id: f.conversation.id, project_id: "" });
    await assert.rejects(f.call("task.proposed_run", { id: proposed.proposal_id }));
    await f.call("execution.cancel", { id: "fixture-scope" }); await assert.rejects(turn);
    await assert.rejects(f.call("task.proposed_run", { id: proposed.proposal_id }));
    await assert.rejects(readFile(join(f.path, "once.txt")));
  } finally { await f.close(); }
});
