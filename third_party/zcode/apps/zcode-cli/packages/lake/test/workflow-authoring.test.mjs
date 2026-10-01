import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LakeData } from "../dist/adapters/storage/data.js";
import { LakeDatabase } from "../dist/adapters/storage/database.js";
import { workflowAuthoringTool } from "../dist/app/workflow-authoring.js";
import { nativeTurnFailure } from "../dist/domain/native-failure.js";

test("workflow authoring saves in the conversation lake without executing, rejects foreign resources and stale amendments", async () => {
  const root = await mkdtemp(join(tmpdir(), "lake-authoring-"));
  const data = new LakeData(await LakeDatabase.open(root)), events = [];
  try {
    await data.request("lake.add", { name: "fixture" });
    await data.request("lake.add", { name: "other" });
    const host = await data.request("res.add", { lake: "fixture", name: "host", spec: { ssh: { host: "example.invalid", port: 22, username: "fixture" } } });
    const tool = workflowAuthoringTool(data, { lake: "fixture" }, [host], async (kind, payload) => events.push({ kind, payload }));
    const spec = { version: 2, name: "CPU巡检", nodes: [{ id: "cpu", kind: "ssh_check", check: "cpu", target: { type: "string", literal: "host" } }] };
    const saved = await tool.call({ version: 2, spec }, new AbortController().signal);
    assert.equal(saved.lake, "fixture");
    assert.equal((await data.request("workflow.v2.list", { lake: "fixture" })).length, 1);
    assert.equal((await data.request("workflow.v2.list", { lake: "other" })).length, 0);
    assert.equal((await data.request("workflow.v2.runs", { lake: "fixture" })).length, 0);
    assert.deepEqual(events.map(event => event.kind), ["workflow_saved"]);
    assert((await data.request("journal.list", {})).some(row => row.tool === "workflow.v2.save"));
    const amendment = { version: 2, definition_id: saved.id, expected_revision: saved.revision, spec: { ...spec, description: "Updated" } };
    await tool.call(amendment, new AbortController().signal);
    await assert.rejects(tool.call(amendment, new AbortController().signal), /更新/);
    await assert.rejects(tool.call({ version: 2, spec: { ...spec, nodes: [{ ...spec.nodes[0], target: { type: "string", literal: "other/host" } }] } }, new AbortController().signal), /当前会话/);
    const foreign = await data.request("workflow.v2.save", { lake: "other", spec });
    await assert.rejects(tool.call({ ...amendment, definition_id: foreign.id, expected_revision: foreign.revision }, new AbortController().signal), /选定湖/);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(tool.call({ version: 2, spec }, cancelled.signal));
    assert.equal((await data.request("workflow.v2.list", { lake: "fixture" })).length, 1);
  } finally { data.close(); await rm(root, { recursive: true, force: true }); }
});

test("native context exhaustion is actionable and raw provider credentials never enter the error", () => {
  const detail = "synthetic-private-key https://example.invalid/private";
  assert.match(nativeTurnFailure({ error: { code: "MODEL_CONTEXT_EXCEEDED", message: detail } }).message, /上下文/);
  assert(!nativeTurnFailure({ error: { code: "MODEL_CONTEXT_EXCEEDED", message: detail } }).message.includes(detail));
  assert(!nativeTurnFailure({ error: { code: "unknown", message: detail, stack: detail } }).message.includes(detail));
  assert(!nativeTurnFailure({ error: {} }).message.includes("ZCode"));
});
