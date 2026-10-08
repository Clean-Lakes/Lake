import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { chmod, symlink, readFile } from "node:fs/promises";
import { testHome } from "../fixtures/home.js";
import { StreamingRedactor } from "../../src/storage/redaction.js";
test("private credentials reject insecure permissions and symlink reads", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const secret = "synthetic-" + crypto.randomUUID();
  await h.credentials.import("models/fixture", Buffer.from(secret));
  assert.equal(
    Buffer.from(await h.credentials.resolve("models/fixture")).toString(),
    secret,
  );
  await chmod(join(h.root, "secrets/models/fixture"), 0o644);
  await assert.rejects(h.credentials.resolve("models/fixture"));
  await chmod(join(h.root, "secrets/models/fixture"), 0o600);
  await symlink(
    join(h.root, "secrets/models/fixture"),
    join(h.root, "secrets/models/link"),
  );
  await assert.rejects(h.credentials.resolve("models/link"));
  await assert.rejects(h.credentials.resolve("models/../../fixture"));
  const id = await h.artifacts.put(`value=${secret}`);
  assert(!(await h.artifacts.read(id)).includes(secret));
  const db = await readFile(h.database);
  assert(!db.includes(Buffer.from(secret)));
});
test("streaming redaction protects secrets crossing arbitrary output chunks", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const value = "syntheticSensitive0123456789";
  h.redactor.register(value);
  for (let split = 1; split < value.length; split++) {
    const stream = new StreamingRedactor(h.redactor);
    const result =
      stream.push("before " + value.slice(0, split)) +
      stream.push(value.slice(split) + " after") +
      stream.flush();
    assert.equal(result, "before [REDACTED] after");
  }
});

test("structured credential components are registered without entering public fields", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const password = "synthetic-" + crypto.randomUUID();
  await h.credentials.import(
    "database/fixture",
    Buffer.from(JSON.stringify({ user: "fixture", password })),
  );
  assert.equal(h.redactor.text(password), "[REDACTED]");
  assert.equal(
    (h.redactor.value({ api_key: password, details: password }) as any).api_key,
    undefined,
  );
  assert.equal(
    (h.redactor.value({ details: password }) as any).details,
    "[REDACTED]",
  );
});

test("unknown PEM blocks are hidden across arbitrary terminal chunks", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const text =
    "-----BEGIN PRIVATE KEY-----\nsynthetic-not-a-key\n-----END PRIVATE KEY-----";
  for (let split = 1; split < text.length; split++) {
    const stream = new StreamingRedactor(h.redactor);
    const out =
      stream.push("before " + text.slice(0, split)) +
      stream.push(text.slice(split) + " after") +
      stream.flush();
    assert.equal(out, "before [REDACTED_PRIVATE_KEY] after");
  }
});
