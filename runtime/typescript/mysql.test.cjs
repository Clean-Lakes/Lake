const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  symlink,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
process.env.LAKE_TS_IMPORT_ONLY = "1";
const {
  startLakeServer,
  importLegacyMySQL,
} = require("../../bin/lake-runtime/server.cjs");

const { mysqlServer } = require("./mysql-fixture.cjs");
async function fixture(t, handler) {
  const wire = await mysqlServer(t, handler),
    home = await mkdtemp(join(tmpdir(), "lake-mysql-test-")),
    web = join(home, "web");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "<html>fixture</html>");
  const app = await startLakeServer({
    home,
    data: join(home, "data"),
    staticRoot: web,
    port: 0,
  });
  t.after(async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
  });
  const project = app.store.createProject("isolated MySQL");
  const settings = app.mysql.prepare({
    driver: "mysql",
    host: "127.0.0.1",
    port: wire.port,
    username: "fixture",
    password: "fixture-only-secret",
    tls: false,
  });
  const resource = {
    id: "mysql-fixture",
    projectId: project.id,
    name: "fixture MySQL",
    kind: "database",
    status: "available",
    description: "",
    settings,
  };
  app.store.put("resources", resource.id, resource);
  const input = (extra = {}) => ({
    asset_ref: resource.id,
    configuration_revision: app.mysql.revision(resource),
    ...extra,
  });
  const read = async (
    name = "list_db_objects",
    extra = {},
    signal = new AbortController().signal,
  ) =>
    app.mysql.read(project.id, resource, name, input(extra), signal, () => {});
  return { ...wire, app, home, project, resource, input, read };
}
test("actual MySQL protocol uses a saved private credential and a read-only transaction with rollback", async (t) => {
  const f = await fixture(t);
  const result = await f.read();
  assert.deepEqual(result.rows, [["fixture_database"]]);
  assert.equal(result.truncated, false);
  assert.deepEqual(f.queries.slice(0, 2), [
    "SET SESSION MAX_EXECUTION_TIME=5000",
    "START TRANSACTION READ ONLY",
  ]);
  assert.equal(f.queries.at(-1), "ROLLBACK");
  assert.doesNotMatch(
    JSON.stringify(result) + JSON.stringify(f.resource),
    /fixture-only-secret/,
  );
  assert.equal(
    (
      await require("node:fs/promises").stat(
        join(f.home, "secrets", f.resource.settings.credentialRef),
      )
    ).mode & 0o777,
    0o600,
  );
});
test("fixed table queries quote identifiers and report bounded rows rather than claiming equality", async (t) => {
  const f = await fixture(t, (conn, sql) =>
    conn.writeTextResult(
      [{ id: "1" }, { id: "2" }, { id: "3" }],
      [
        {
          name: "id",
          columnType: 253,
          characterSet: 45,
          columnLength: 1024,
          flags: 0,
        },
      ],
    ),
  );
  const result = await f.read("read_db_table", {
    db: "app`data",
    table: "t`;DROP TABLE t",
    columns: ["id"],
    order_by: ["id"],
    limit: 2,
  });
  assert.equal(result.rows.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.nextOffset, 2);
  assert.match(
    f.queries[2],
    /^SELECT `id` FROM `app``data`\.`t``;DROP TABLE t` ORDER BY `id` LIMIT 3 OFFSET 0$/,
  );
  assert.match(result.notice, /not a cross-server/);
});
test("current project, credential content, private file permissions and limits are checked before any I/O", async (t) => {
  const f = await fixture(t),
    original = f.input();
  await assert.rejects(
    () =>
      f.app.mysql.read(
        "other",
        f.resource,
        "list_db_objects",
        original,
        new AbortController().signal,
        () => {},
      ),
    /当前项目/,
  );
  await writeFile(
    join(f.home, "secrets", f.resource.settings.credentialRef),
    JSON.stringify({ password: "new-fixture-secret" }),
    { mode: 0o600 },
  );
  await assert.rejects(
    () =>
      f.app.mysql.read(
        f.project.id,
        f.resource,
        "list_db_objects",
        original,
        new AbortController().signal,
        () => {},
      ),
    /配置或凭据已变化/,
  );
  await assert.rejects(
    () => f.read("read_db_table", { db: "app", table: "t", limit: 501 }),
    /数量或偏移/,
  );
  await chmod(
    join(f.home, "secrets", f.resource.settings.credentialRef),
    0o644,
  );
  await assert.rejects(() => f.read(), /私有文件/);
  assert.equal(f.queries.length, 0);
});

test("the shared resource form's sslmode is accepted only when it preserves the saved TLS choice", async (t) => {
  const f = await fixture(t);
  const settings = f.app.mysql.prepare({
    ...f.resource.settings,
    sslmode: "disable",
    password: "",
  });
  assert.deepEqual(settings, f.resource.settings);
  assert.throws(
    () =>
      f.app.mysql.prepare({
        ...f.resource.settings,
        tls: true,
        sslmode: "disable",
      }),
    /TLS/,
  );
  assert.throws(
    () =>
      f.app.mysql.prepare({ ...f.resource.settings, sslmode: "skip-verify" }),
    /TLS/,
  );
  assert.equal(f.queries.length, 0);
});
test("cancellation interrupts an actual pending MySQL request and releases the connection", async (t) => {
  let started;
  const ready = new Promise((resolve) => (started = resolve));
  const f = await fixture(t, () => started());
  const controller = new AbortController(),
    read = f.read("list_db_objects", {}, controller.signal);
  await ready;
  controller.abort();
  await assert.rejects(read, /取消/);
  assert.equal(f.app.mysql.connections.size, 0);
});
test("network/result caps fail without publishing a partial or oversized database result", async (t) => {
  const f = await fixture(t, (conn) =>
    conn.writeTextResult(
      [{ value: "x".repeat(600000) }],
      [
        {
          name: "value",
          columnType: 253,
          characterSet: 45,
          columnLength: 700000,
          flags: 0,
        },
      ],
    ),
  );
  await assert.rejects(() => f.read(), /字节上限|读取预算/);
});

test("column metadata alone cannot exceed the result byte budget", async (t) => {
  const f = await fixture(t, (connection) =>
    connection.writeTextResult([], [{ name: "x".repeat(120000) }]),
  );
  await assert.rejects(() => f.read(), /读取预算/);
});
test("legacy policy schema restrictions and row/time ceilings remain authoritative", async (t) => {
  const f = await fixture(t);
  f.app.store.put("legacyProjectPolicies", f.project.id, {
    data: {
      SchemaVersion: 1,
      Confirmed: true,
      ProjectID: f.project.id,
      Mode: "restricted",
      Revision: 1,
      ResourceIDs: [f.resource.id],
      Rules: [
        { Capability: "resource.resolve", Effect: "allow" },
        {
          Capability: "db.read",
          Effect: "allow",
          Limits: {
            DatabaseID: "app",
            Schemas: ["app"],
            MaxRows: 2,
            MaxDurationMS: 2000,
          },
        },
      ],
    },
  });
  await assert.rejects(() => f.read(), /schema/);
  const plan = f.app.mysql.plan(
    f.resource,
    "read_db_table",
    f.input({ db: "app", table: "t", limit: 100 }),
  );
  assert.equal(plan.scope.maxRows, 2);
  assert.equal(plan.scope.maxDurationMS, 2000);
  assert.equal(plan.provenReadOnly, false);
  const result = await f.read("list_db_objects", {
    db: "app",
    query_type: "table",
  });
  assert.equal(result.rows.length, 1);
  assert.equal(f.queries[0], "SET SESSION MAX_EXECUTION_TIME=2000");
});

test("a short policy deadline interrupts a stalled MySQL response and symlinked credentials never connect", async (t) => {
  const f = await fixture(t, () => {});
  f.app.store.put("legacyProjectPolicies", f.project.id, {
    data: {
      SchemaVersion: 1,
      Confirmed: true,
      ProjectID: f.project.id,
      Mode: "restricted",
      Revision: 1,
      ResourceIDs: [f.resource.id],
      Rules: [
        { Capability: "resource.resolve", Effect: "allow" },
        {
          Capability: "db.read",
          Effect: "allow",
          Limits: {
            DatabaseID: "app",
            Schemas: ["app"],
            MaxRows: 2,
            MaxDurationMS: 40,
          },
        },
      ],
    },
  });
  await assert.rejects(
    () => f.read("list_db_objects", { db: "app", query_type: "table" }),
    /超时/,
  );
  assert.equal(f.app.mysql.connections.size, 0);
  const before = f.queries.length;
  await symlink(
    join(f.home, "secrets", f.resource.settings.credentialRef),
    join(f.home, "secrets", "linked.json"),
  );
  assert.throws(
    () =>
      f.app.mysql.configuration({
        ...f.resource.settings,
        credentialRef: "linked.json",
      }),
    /私有文件/,
  );
  assert.equal(f.queries.length, before);
});

test("legacy MySQL import preserves exact Dev references, source bytes, TS edits and original unknown operations", async (t) => {
  const f = await fixture(t),
    { DatabaseSync } = require("node:sqlite");
  const path = join(f.app.store.data, "lake-web.sqlite"),
    source = new DatabaseSync(path);
  source.exec(
    "CREATE TABLE resources(id TEXT,projectId TEXT,kind TEXT);CREATE TABLE resourceConnections(resourceId TEXT,config TEXT)",
  );
  const add = (id, settings, kind = "database") => {
    source
      .prepare("INSERT INTO resources VALUES(?,?,?)")
      .run(id, f.project.id, kind);
    source
      .prepare("INSERT INTO resourceConnections VALUES(?,?)")
      .run(id, JSON.stringify(settings));
    f.app.store.put("resources", id, {
      ...f.resource,
      id,
      kind,
      status: "unavailable",
      settings: {},
    });
    f.app.store.put("legacyResources", id, { originalStatus: "available" });
  };
  add("import-mysql", f.resource.settings);
  add("import-postgres", { driver: "postgres", host: "127.0.0.1" });
  add("import-bad-ref", {
    ...f.resource.settings,
    credentialRef: "missing.json",
  });
  add("changed-kind", f.resource.settings);
  f.app.store.put("resources", "changed-kind", {
    ...f.resource,
    id: "changed-kind",
    kind: "local",
    settings: {},
  });
  source.close();
  await chmod(path, 0o600);
  const bytes = await readFile(path);
  f.app.store.put("superOperations", "old-unknown", {
    id: "old-unknown",
    status: "unknown",
    goalId: "old-goal",
  });
  const operations = JSON.stringify(f.app.store.list("superOperations"));
  await importLegacyMySQL(f.app.store, f.app.mysql);
  const imported = f.app.store.require("resources", "import-mysql");
  assert.equal(imported.status, "available");
  assert.deepEqual(imported.settings, f.resource.settings);
  assert.equal(
    f.app.store.require("resources", "import-postgres").status,
    "unavailable",
  );
  assert.equal(
    f.app.store.require("resources", "import-bad-ref").status,
    "unavailable",
  );
  assert.equal(f.app.store.require("resources", "changed-kind").kind, "local");
  assert.ok(f.app.store.get("legacyMySQLConnectionErrors", "import-bad-ref"));
  const updated = {
    ...imported,
    settings: { ...imported.settings, port: 3307 },
  };
  f.app.store.put("resources", updated.id, updated);
  await importLegacyMySQL(f.app.store, f.app.mysql);
  assert.equal(
    f.app.store.require("resources", updated.id).settings.port,
    3307,
  );
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(JSON.stringify(f.app.store.list("superOperations")), operations);
  assert.equal(f.queries.length, 0);
});
