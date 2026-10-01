import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileVault } from "../dist/adapters/vault.js";
import { redact } from "../dist/domain/validation.js";

test("file vault preserves private credential references and rejects permissive files/symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "lake-ts-vault-")), vault = new FileVault(root);
  try {
    const ref = await vault.import("ssh", Buffer.from("synthetic unusable test key"));
    assert.match(ref, /^file:ssh\/[a-f0-9]{32}$/u);
    assert.equal((await vault.loadReference(ref)).toString(), "synthetic unusable test key");
    const path = await vault.referencePath(ref);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await chmod(path, 0o644);
    await assert.rejects(vault.loadReference(ref), /权限不安全/u);
    await chmod(path, 0o600);
    await rm(path); await symlink(join(root, "absent"), path);
    await assert.rejects(vault.loadReference(ref), /权限不安全/u);
    await assert.rejects(vault.loadReference("file:ssh/../../outside"));
    await assert.rejects(vault.load("model", "../outside"));
    await assert.rejects(vault.loadReference("keychain:old"), /migrate/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("secret-like output is redacted before persistence or display", () => {
  assert.equal(redact("-----BEGIN PRIVATE KEY-----\nsynthetic"), "[redacted]");
  assert.equal(redact("Authorization: Bearer synthetic"), "[redacted]");
  assert.equal(redact("password=synthetic"), "[redacted]");
});
