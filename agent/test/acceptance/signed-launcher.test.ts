import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
async function run(file: string, args: string[], cwd: string) {
  return new Promise<{ code: number | null; out: string; err: string }>(
    (resolve, reject) => {
      const child = spawn(file, args, {
        cwd,
        env: {
          ...process.env,
          PATH: "/usr/bin:/bin",
          LAKE_ZCODE_DIR: "",
          LAKE_EXPLICIT_SECRET_MIGRATION: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "",
        err = "";
      child.stdout.on("data", (b) => (out += b));
      child.stderr.on("data", (b) => (err += b));
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, out, err }));
    },
  );
}
test("prescribed macOS launcher and native runtime have persistent signatures and start outside source", async (t) => {
  assert.equal(
    process.platform,
    "darwin",
    "The signed launcher gate requires macOS",
  );
  const repo = resolve(import.meta.dirname, "../../.."),
    cwd = await mkdtemp(join(tmpdir(), "lake-launcher-gate-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const launcher = join(repo, "bin/lake"),
    release = JSON.parse(
      await readFile(join(repo, "agent/dist/release.json"), "utf8"),
    ),
    runtime = join(repo, "bin", release.path),
    manifest = JSON.parse(
      await readFile(join(runtime, "manifest.json"), "utf8"),
    );
  for (const file of [
    launcher,
    join(runtime, "node"),
    ...Object.keys(manifest.files)
      .filter((f) => f.endsWith(".node"))
      .map((f) => join(runtime, f)),
  ]) {
    assert.equal(
      (await run("/usr/bin/codesign", ["--verify", "--strict", file], cwd))
        .code,
      0,
    );
    const signature = await run("/usr/bin/codesign", ["-dvv", file], cwd);
    assert(
      signature.err.includes("Authority=Lake Local Development Code Signing"),
    );
  }
  const version = await run(launcher, ["version"], cwd);
  assert.equal(version.code, 0);
  assert.deepEqual(JSON.parse(version.out), {
    version: "0.0.1",
    node: "24.14.0",
  });
  const denied = await run(
    launcher,
    ["__legacy_keychain", "load-model", "synthetic-not-used"],
    cwd,
  );
  assert.equal(denied.code, 1);
  assert.equal(denied.out, "");
});
