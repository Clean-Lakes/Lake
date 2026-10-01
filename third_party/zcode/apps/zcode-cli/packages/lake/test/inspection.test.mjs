import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chmod, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectionSQL, kubeArgs, resourceIdentity } from "../dist/domain/inspection.js";
import { FileVault } from "../dist/adapters/vault.js";
import { InspectionTransport } from "../dist/adapters/execution/inspection.js";

test("fixed inspection plans reject arbitrary SQL, flags and Secret reads", () => {
  assert.equal(inspectionSQL("mysql", "version", ""), "SELECT VERSION()");
  assert.match(inspectionSQL("postgres", "tables", ""), /LIMIT 201$/u);
  assert.throws(() => inspectionSQL("mysql", "tables", ""));
  assert.throws(() => inspectionSQL("mysql", "DROP DATABASE", "fixture"));
  for (const p of [{ kind: "secrets" }, { kind: "pods", name: "--raw" }, { kind: "pods", namespace: "../../default" }]) assert.throws(() => kubeArgs(p, { context: "fixture" }));
  assert.deepEqual(kubeArgs({ kind: "pods" }, { context: "fixture" }), ["--context", "fixture", "--request-timeout=20s", "--namespace", "default", "get", "pods", "--output=wide"]);
  assert.notEqual(resourceIdentity({ id: "r", ssh: { host: "before" } }), resourceIdentity({ id: "r", ssh: { host: "after" } }));
});

test("Kubernetes uses a private temporary config, sanitizes env and removes config on success and failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "lake-kube-test-")), previous = process.env.PATH, marker = join(root, "paths");
  const vault = new FileVault(root), transport = new InspectionTransport(vault);
  try {
    const ref = await vault.import("kubeconfig", Buffer.from("synthetic-config-only"));
    await writeFile(join(root, "kubectl"), `#!/bin/sh\n[ -z "$SYNTHETIC_MODEL_KEY" ] || exit 3\n[ "$(stat -f %Lp "$2")" = 600 ] || exit 4\nprintf '%s\\n' "$2" >> '${marker}'\n[ "$4" = 'fixture-fail' ] && { printf 'password=fixture-only' >&2; exit 1; }\nprintf 'fixture pods'\n`);
    await chmod(join(root, "kubectl"), 0o700); process.env.PATH = root + ":" + previous; process.env.SYNTHETIC_MODEL_KEY = "fixture-only";
    const p = { resource: { lake: "fixture", name: "cluster", k8s: { context: "fixture" } }, kind: "pods", credential_ref: ref };
    const result = await transport.request("transport.k8s", p, new AbortController().signal);
    assert.equal(result.output, "fixture pods");
    p.resource.k8s.context = "fixture-fail";
    const failure = await transport.request("transport.k8s", p, new AbortController().signal);
    assert.equal(failure.status, "failed"); assert(!JSON.stringify(failure).includes("password="));
    for (const path of (await readFile(marker, "utf8")).trim().split("\n")) await assert.rejects(readFile(path), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(root, "secrets", "kubeconfig")), [ref.split("/")[1]]);
  } finally { process.env.PATH = previous; delete process.env.SYNTHETIC_MODEL_KEY; await rm(root, { recursive: true, force: true }); }
});

test("database driver diagnostics never expose private password and cancellation settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "lake-db-test-")), sockets = new Set();
  const server = createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const vault = new FileVault(root), ref = await vault.import("database", Buffer.from("fixture-only-password")), transport = new InspectionTransport(vault);
    for (const kind of ["postgres", "mysql"]) {
      const controller = new AbortController(), pending = transport.request("transport.database", { resource: { kind, lake: "fixture", name: "db", db: { host: "127.0.0.1", port: server.address().port, username: "fixture", database: "fixture", tls_mode: "disable" } }, check: "version", credential_ref: ref }, controller.signal);
      setTimeout(() => controller.abort(), 20);
      const result = await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error("cancel hung")), 3000).unref())]);
      assert.equal(result.status, "unknown"); assert(!JSON.stringify(result).includes("fixture-only-password"));
    }
  } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
