import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLakeRuntime } from "../dist/contract.js";

const execute = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lake-ts-workbench-")), path = join(root, "project");
  await mkdir(path); const runtime = await createLakeRuntime({ root: join(root, "data") });
  const call = (method, params = {}, id) => runtime.dispatch({ method, params, id });
  await call("lake.add", { name: "fixture" });
  const project = await call("code.add", { lake: "fixture", path });
  return { root, path: project.path, runtime, call, project, close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}

test("registered workspace file/Git views preserve shapes and reject credential/symlink escapes", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.path, "hello.ts"), "first\nsecond\n");
    await writeFile(join(f.path, ".env"), "synthetic fixture");
    await writeFile(join(f.root, "outside.txt"), "outside");
    await symlink(join(f.root, "outside.txt"), join(f.path, "escape.txt"));
    assert.deepEqual(await f.call("workbench.files", { project_id: f.project.id }), ["hello.ts"]);
    const read = await f.call("workbench.read", { project_id: f.project.id, path: "hello.ts" });
    assert.deepEqual(read.lines, ["1: first", "2: second", "3: "]);
    for (const path of [".env", "../outside.txt", "escape.txt"]) await assert.rejects(f.call("workbench.read", { project_id: f.project.id, path }));
    await execute("git", ["init", "--quiet", f.path]);
    const overview = await f.call("workbench.git", { project_id: f.project.id });
    assert(overview.files.some(file => file.path === "hello.ts"));
    assert(!overview.files.some(file => file.path === ".env"));
    const diff = await f.call("workbench.diff", { project_id: f.project.id, path: "hello.ts" });
    assert(diff.includes("+first"));
    await assert.rejects(f.call("workbench.diff", { project_id: f.project.id, path: ".env" }));
  } finally { await f.close(); }
});

test("TypeScript terminal approval, persistent cd/export and duplicate admission append one audit", async () => {
  const f = await fixture(), approvals = [];
  f.runtime.subscribe(event => { if (event.type === "approval") { approvals.push(event); void f.call("approval.respond", { id: event.approval_id, approved: true }); } });
  try {
    await mkdir(join(f.path, "sub"));
    const terminal = await f.call("workbench.terminal.open", { project_id: f.project.id });
    const first = await f.call("workbench.terminal.run", { id: terminal.id, command: "cd sub; export LAKE_TEST_VALUE=fixture" });
    assert.equal(first.next_directory, join(f.path, "sub"));
    const params = { id: terminal.id, command: "printf '%s' \"$LAKE_TEST_VALUE\"; printf x >> once.txt" };
    const [second, duplicate] = await Promise.all([f.call("workbench.terminal.run", params, "fixture-once"), f.call("workbench.terminal.run", params, "fixture-once")]);
    assert.deepEqual(second, duplicate); assert.equal(second.stdout, "fixture");
    assert.equal(await readFile(join(f.path, "sub", "once.txt"), "utf8"), "x");
    assert.equal(approvals.length, 3);
    const audit = await f.call("journal.list", { action_id: "fixture-once" });
    assert.deepEqual(audit.map(row => row.event).reverse(), ["requested", "proposed", "approved", "started", "completed"]);
    assert(audit.every(row => row.detail.startsWith("arguments_sha256=")));
    await f.call("workbench.terminal.close", { id: terminal.id });
    await assert.rejects(f.call("workbench.terminal.run", { id: terminal.id, command: "pwd" }));
  } finally { await f.close(); }
});

test("denied terminal commands dispatch nothing and cancellation closes a shell with unknown outcome", async () => {
  const f = await fixture(); let allow = true;
  f.runtime.subscribe(event => { if (event.type === "approval") void f.call("approval.respond", { id: event.approval_id, approved: allow }); });
  try {
    const terminal = await f.call("workbench.terminal.open", { project_id: f.project.id });
    allow = false;
    await assert.rejects(f.call("workbench.terminal.run", { id: terminal.id, command: "printf x > denied.txt" }));
    await assert.rejects(readFile(join(f.path, "denied.txt")));
    allow = true;
    const result = f.call("workbench.terminal.run", { id: terminal.id, command: "printf started > started.txt; sleep 30" }, "cancel-fixture");
    for (let i = 0; i < 100; i++) {
      try { await readFile(join(f.path, "started.txt")); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    await f.call("execution.cancel", { id: "cancel-fixture" });
    assert.equal((await result).status, "unknown");
    assert.equal((await f.call("workbench.terminal.status", { id: terminal.id })).closed, true);
    const audit = await f.call("journal.list", { action_id: "cancel-fixture" });
    assert.equal(audit[0].event, "unknown");
  } finally { await f.close(); }
});
