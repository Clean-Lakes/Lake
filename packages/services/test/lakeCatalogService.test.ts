import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLakeCatalogService } from "../src/lake-catalog/lakeCatalogService.js";

test("lake catalog persists one resource shared by two lakes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lake-catalog-"));
  const databasePath = join(dir, "catalog.sqlite");
  const service = createLakeCatalogService({ databasePath });
  try {
    const first = await service.createLake({ name: "订单系统" });
    const second = await service.createLake({ name: "结算系统" });
    const resource = await service.createResourceInLake(first.id, {
      name: "订单 API",
      kind: "service",
      environment: "production",
    });
    assert.deepEqual(await service.addResourceToLake(second.id, resource.id), resource);
    assert.deepEqual(await service.addResourceToLake(second.id, resource.id), resource);
    assert.equal((await service.listLakeResources(second.id)).length, 1);
    assert.equal((await service.listResources()).length, 1);
    service.close();

    const reopened = createLakeCatalogService({ databasePath });
    try {
      assert.equal((await reopened.listLakes()).length, 2);
      assert.equal((await reopened.listLakeResources(first.id))[0]?.id, resource.id);
      assert.equal((await reopened.listLakeResources(second.id))[0]?.id, resource.id);
    } finally {
      reopened.close();
    }
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lake catalog rejects invalid writes without orphan resources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lake-catalog-"));
  const service = createLakeCatalogService({ databasePath: join(dir, "catalog.sqlite") });
  try {
    const lake = await service.createLake({ name: "订单系统" });
    await assert.rejects(service.createLake({ name: "  订单系统  " }), /already exists/i);
    await service.createLake({ name: "Payments" });
    await assert.rejects(service.createLake({ name: "payments" }), /already exists/i);
    await assert.rejects(service.createLake({ name: "  " }), /name/i);
    await assert.rejects(
      service.createResourceInLake("missing", {
        name: "孤儿",
        kind: "service",
        environment: "production",
      }),
      /lake not found/i,
    );
    await assert.rejects(service.addResourceToLake(lake.id, "missing"), /resource not found/i);
    assert.deepEqual(await service.listResources(), []);
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("two host instances share the database uniqueness boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lake-catalog-"));
  const databasePath = join(dir, "catalog.sqlite");
  const first = createLakeCatalogService({ databasePath });
  const second = createLakeCatalogService({ databasePath });
  try {
    const results = await Promise.allSettled([
      first.createLake({ name: "Payments" }),
      second.createLake({ name: "payments" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await first.listLakes()).length, 1);
    assert.equal((await second.listLakes()).length, 1);
  } finally {
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lake workspace binding owns sessions by identity and survives reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lake-catalog-"));
  const databasePath = join(dir, "catalog.sqlite");
  const service = createLakeCatalogService({ databasePath });
  try {
    const local = await service.createLake({
      name: "本地项目",
      workspacePath: "/work/project",
    });
    const remote = await service.createLake({ name: "远程项目" });
    assert.equal((await service.getLakeForWorkspace("/work/project"))?.id, local.id);
    assert.equal(await service.getLakeForWorkspace("/work/project", "remote:one"), null);
    await assert.rejects(
      service.bindLakeWorkspace(remote.id, { workspacePath: "/work/project" }),
      /already bound/i,
    );
    const bound = await service.bindLakeWorkspace(remote.id, {
      workspacePath: "/work/project",
      workspaceIdentity: "remote:one",
    });
    assert.equal(bound.workspaceIdentity, "remote:one");
    assert.equal((await service.getLakeForWorkspace("/work/project", "remote:one"))?.id, remote.id);
    service.close();
    const reopened = createLakeCatalogService({ databasePath });
    try {
      assert.equal((await reopened.getLakeForWorkspace("/work/project"))?.id, local.id);
      assert.equal(
        (await reopened.getLakeForWorkspace("/work/project", "remote:one"))?.id,
        remote.id,
      );
    } finally {
      reopened.close();
    }
  } finally {
    service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
