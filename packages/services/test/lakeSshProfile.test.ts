import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLakeCatalogService } from "../src/lake-catalog/lakeCatalogService.js";

test("one host resource has one SSH profile even when shared by two lakes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lake-ssh-profile-"));
  const dbPath = join(dir, "catalog.sqlite");
  const catalog = createLakeCatalogService({ databasePath: dbPath });
  try {
    const first = await catalog.createLake({ name: "生产" });
    const second = await catalog.createLake({ name: "值班" });
    const host = await catalog.createResourceInLake(first.id, {
      name: "api-01",
      kind: "host",
      environment: "production",
    });
    await catalog.addResourceToLake(second.id, host.id);
    await catalog.saveSshProfile(host.id, {
      host: "api-01.example.test",
      port: 2222,
      username: "operator",
      privateKeyPath: "/tmp/operator-key",
    });
    assert.equal((await catalog.getSshProfile(host.id))?.host, "api-01.example.test");
    catalog.close();

    const reopened = createLakeCatalogService({ databasePath: dbPath });
    try {
      assert.equal((await reopened.getSshProfile(host.id))?.port, 2222);
      assert.equal((await reopened.listLakeResources(second.id))[0]?.id, host.id);
    } finally {
      reopened.close();
    }
  } finally {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SSH profiles reject non-host resources and invalid targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lake-ssh-profile-"));
  const catalog = createLakeCatalogService({ databasePath: join(dir, "catalog.sqlite") });
  try {
    const lake = await catalog.createLake({ name: "生产" });
    const database = await catalog.createResourceInLake(lake.id, {
      name: "db-01",
      kind: "database",
      environment: "production",
    });
    await assert.rejects(
      catalog.saveSshProfile(database.id, { host: "db.example.test", port: 22, username: "dba" }),
      /host resource/i,
    );
    const host = await catalog.createResourceInLake(lake.id, {
      name: "api-01",
      kind: "host",
      environment: "production",
    });
    await assert.rejects(
      catalog.saveSshProfile(host.id, { host: "-oProxyCommand=bad", port: 22, username: "ops" }),
      /host/i,
    );
    await assert.rejects(
      catalog.saveSshProfile(host.id, { host: "api.example.test", port: 0, username: "ops" }),
      /port/i,
    );
    assert.equal(await catalog.getSshProfile(host.id), null);
  } finally {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});
