import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ICredentialService } from "../src/credential/credential.js";
import { createLakeCatalogService } from "../src/lake-catalog/lakeCatalogService.js";
import { lakeSshPasswordKey } from "../src/lake-catalog/lakeSshPasswordKey.js";

test("host SSH password is stored through credentials and never returned with profile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lake-ssh-password-"));
  const values = new Map<string, string>();
  const credentials: ICredentialService = {
    async load(key) {
      return values.get(key) ?? null;
    },
    async save(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
  const catalog = createLakeCatalogService({
    databasePath: join(dir, "catalog.sqlite"),
    credentialService: credentials,
  });
  try {
    const lake = await catalog.createLake({ name: "production" });
    const host = await catalog.createResourceInLake(lake.id, {
      name: "api-01",
      kind: "host",
      environment: "production",
    });
    const database = await catalog.createResourceInLake(lake.id, {
      name: "db-01",
      kind: "database",
      environment: "production",
    });
    await catalog.saveSshProfile(host.id, { host: "api.example.test", port: 22, username: "ops" });

    await assert.rejects(catalog.saveSshPassword(database.id, "secret"), /host resource/i);
    await assert.rejects(catalog.saveSshPassword(host.id, ""), /password/i);
    await catalog.saveSshPassword(host.id, "secret");
    assert.equal(values.get(lakeSshPasswordKey(host.id)), "secret");
    assert.equal(await catalog.hasSshPassword(host.id), true);
    assert.equal(JSON.stringify(await catalog.getSshProfile(host.id)).includes("secret"), false);

    await catalog.deleteSshPassword(host.id);
    assert.equal(await catalog.hasSshPassword(host.id), false);
    assert.equal(values.has(lakeSshPasswordKey(host.id)), false);
  } finally {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});
