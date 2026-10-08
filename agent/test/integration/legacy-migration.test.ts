import test from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { testHome } from "../fixtures/home.js";
import {
  migrateCredentialEntries,
  migrateFromSignedPipe,
} from "../../src/storage/legacy-migration.js";
test("explicit synthetic migration validates mapping, private permissions and idempotent conflicts without Keychain", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const mapping = {
      schemaVersion: 1,
      entries: [
        {
          kind: "model",
          legacyId: "synthetic-old",
          newCredentialId: "fixture",
        },
      ],
    },
    secret = Buffer.from(crypto.randomUUID());
  await migrateCredentialEntries(h.root, mapping, async () =>
    Buffer.from(secret),
  );
  assert.equal(
    (await stat(join(h.root, "secrets/models/fixture"))).mode & 0o777,
    0o600,
  );
  await migrateCredentialEntries(h.root, mapping, async () =>
    Buffer.from(secret),
  );
  await assert.rejects(
    migrateCredentialEntries(h.root, mapping, async () =>
      Buffer.from("different synthetic fixture"),
    ),
  );
  await assert.rejects(
    migrateCredentialEntries(
      h.root,
      {
        ...mapping,
        entries: [{ ...mapping.entries[0], newCredentialId: "../escape" }],
      },
      async () => Buffer.from(secret),
    ),
  );
  await assert.rejects(migrateFromSignedPipe(h.root, mapping));
  secret.fill(0);
});
