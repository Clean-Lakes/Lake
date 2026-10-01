import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteWorkspaceAdapter } from "../dist/adapters/workspace/remote.js";
import { LocalTerminal } from "../dist/adapters/workspace/terminal.js";
import { remotePlan, remotePrefix } from "../dist/domain/remote.js";
import { shellQuote } from "../dist/domain/workspace.js";

test("remote read rejects symlink escapes and persistent remote shell retains state", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lake-remote-"))), signal = new AbortController().signal;
  const adapter = new RemoteWorkspaceAdapter(async p => {
    try { const result = await promisify(execFile)("sh", ["-c", p.command]); return { ...result, exit_code: 0, truncated: false, status: "completed" }; }
    catch { return { stdout: "", stderr: "", exit_code: 76, truncated: false, status: "failed" }; }
  }, async p => new LocalTerminal(p.root, { executable: "sh", args: ["-c", remotePrefix(p.root) + "exec sh 3>&1"], user: "fixture", remote: true }));
  try {
    await writeFile(join(root, "fixture.txt"), "fixture"); await symlink(join(root, "fixture.txt"), join(root, "link.txt"));
    assert.equal((await adapter.request("remote.read", { root, path: "fixture.txt" }, signal)).value.content, "fixture");
    await assert.rejects(adapter.request("remote.read", { root, path: "link.txt" }, signal));
    for (const path of ["../outside", ".ssh/id_rsa", ".env", "a/.lake/config"]) assert.throws(() => remotePlan("remote.read", { root, path }));
    const scope = { root, resource: { id: "fixture" }, credential_ref: "fixture" }, terminal = await adapter.request("remote.terminal.open", scope, signal);
    await adapter.request("remote.terminal.run", { ...scope, id: terminal.id, command: "export FIXTURE_STATE=retained" }, signal);
    assert.equal((await adapter.request("remote.terminal.run", { ...scope, id: terminal.id, command: "printf '%s' \"$FIXTURE_STATE\"" }, signal)).stdout, "retained");
    await assert.rejects(adapter.request("remote.terminal.run", { ...scope, resource: { id: "changed" }, id: terminal.id, command: "true" }, signal));
    assert(remotePlan("remote.write", { root, path: "quote'test.txt", content: "fixture", expected_sha256: "absent" }).command.includes(shellQuote("quote'test.txt").replaceAll("'", "'\"'\"'")));
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});
