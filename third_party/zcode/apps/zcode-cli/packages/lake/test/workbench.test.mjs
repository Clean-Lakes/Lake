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

test("ZCode PTY streams output and preserves shell state; duplicate submission is admitted once", { timeout: 10000 }, async () => {
  const f = await fixture(), chunks = [];
  f.runtime.subscribe(event => { if (event.type === "terminal_data") chunks.push(event.text); });
  try {
    await mkdir(join(f.path, "sub"));
    const terminal = await f.call("workbench.terminal.open", { project_id: f.project.id });
    assert.equal(terminal.native, true);
    await f.call("workbench.terminal.run", { id: terminal.id, command: "cd sub; export LAKE_TEST_VALUE=fixture" });
    const params = { id: terminal.id, command: "printf '%s' \"$LAKE_TEST_VALUE\"; printf x >> once.txt" };
    const [submitted, duplicate] = await Promise.all([f.call("workbench.terminal.run", params, "fixture-once"), f.call("workbench.terminal.run", params, "fixture-once")]);
    assert.deepEqual(submitted, duplicate); assert.equal(submitted.status, "submitted");
    for (let i = 0; i < 100; i++) { try { if ((await readFile(join(f.path, "sub", "once.txt"), "utf8")) === "x" && chunks.join("").includes("fixture")) break; } catch {} await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(await readFile(join(f.path, "sub", "once.txt"), "utf8"), "x"); assert(chunks.join("").includes("fixture"));
    await f.call("workbench.terminal.close", { id: terminal.id });
    await assert.rejects(f.call("workbench.terminal.run", { id: terminal.id, command: "pwd" }), /已关闭/);
  } finally { await f.close(); }
});

test("native file write rejects stale content hashes and bounds edits before dispatch",async()=>{
 const {createFileService}=await import("../../../../../packages/services/dist/lake-host.js");const {createHash}=await import("node:crypto"), root=await mkdtemp(join(tmpdir(),"lake-native-cas-")),path=join(root,"fixture.txt"),files=createFileService();
 const sha=value=>createHash("sha256").update(value).digest("hex");
 try{await writeFile(path,"first");assert.equal((await files.writeTextFile({path,content:"second",expectedSha256:sha("first")})).sha256,sha("second"));await assert.rejects(files.writeTextFile({path,content:"stale",expectedSha256:sha("first")}));assert.equal(await readFile(path,"utf8"),"second");await assert.rejects(files.writeTextFile({path,content:"x".repeat(65537),expectedSha256:sha("second")}));}finally{await rm(root,{recursive:true,force:true});}
});
