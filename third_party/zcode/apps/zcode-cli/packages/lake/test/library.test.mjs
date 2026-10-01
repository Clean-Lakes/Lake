import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLakeRuntime } from "../dist/contract.js";

test("workflow library move/order/cycle checks preserve definition revision and lake scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "lake-ts-library-")), runtime = await createLakeRuntime({ root });
  const call = (method, params) => runtime.dispatch({ method, params }), library = params => call("workflow.library", params);
  try {
    for (const name of ["fixture", "other"]) await call("lake.add", { name });
    const first = await library({ action: "create_folder", lake: "fixture", name: "Folder" });
    const folder = first.created_id;
    const child = (await library({ action: "create_folder", lake: "fixture", name: "Child", parent_id: folder })).created_id;
    await assert.rejects(library({ action: "move", lake: "fixture", kind: "folder", id: folder, parent_id: child }));
    await assert.rejects(library({ action: "create_folder", lake: "fixture", name: "folder" }));
    const other = (await library({ action: "create_folder", lake: "other", name: "Other" })).created_id;
    await assert.rejects(library({ action: "move", lake: "fixture", kind: "folder", id: folder, parent_id: other }));
    await assert.rejects(library({ action: "delete_folder", lake: "fixture", id: folder }));
    const spec = { version: 2, name: "Fixture workflow", nodes: [{ id: "check", kind: "ssh_check", target: { type: "string", literal: "host" }, check: "uptime" }] };
    const definition = await call("workflow.v2.save", { lake: "fixture", spec });
    await library({ action: "move", lake: "fixture", kind: "v2", id: definition.id, parent_id: folder, before_kind: "folder", before_id: child });
    const after = await call("workflow.v2.get", { id: definition.id });
    assert.deepEqual(after, definition);
    const items = (await library({ action: "list", lake: "fixture" })).entries.filter(entry => entry.parent_id === folder);
    assert.deepEqual(items.map(entry => entry.kind), ["v2", "folder"]);
    assert.deepEqual(items.map(entry => entry.position), [0, 1]);
    await assert.rejects(library({ action: "list", unexpected: "value" }));
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
