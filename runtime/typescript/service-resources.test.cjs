const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createServer } = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
process.env.LAKE_TS_IMPORT_ONLY = "1";
const { startLakeServer } = require("../../bin/lake-runtime/server.cjs");
const { mysqlServer } = require("./mysql-fixture.cjs");
async function fixture(t) {
  const home = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), "lake-services-")),
    ),
    web = join(home, "web");
  await fs.mkdir(web);
  await fs.writeFile(join(web, "index.html"), "<html>fixture</html>");
  const app = await startLakeServer({
      home,
      data: join(home, "data"),
      staticRoot: web,
      port: 0,
    }),
    project = app.store.createProject("isolated services");
  t.after(async () => {
    await app.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  async function api(path, method = "GET", body, status = 200) {
    const response = await fetch(app.origin + path, {
      method,
      headers: {
        Authorization: "Bearer " + app.token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  return {
    app,
    project,
    home,
    api,
    path: "/api/projects/" + project.id + "/resources",
  };
}
async function http(t, handler) {
  const server = createServer(handler);
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(
    () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(ok);
      }),
  );
  return "http://127.0.0.1:" + server.address().port;
}
const input = (kind, settings, name = kind) => ({ name, kind, settings });
const secretFiles = async (home) =>
  (await fs.readdir(join(home, "secrets")).catch(() => [])).filter((name) =>
    name.startsWith("service-"),
  );

test('legacy PostgreSQL and Redis configurations adopt exact private Dev references without copying secrets or overwriting later edits', async t => {
  const f = await fixture(t), {DatabaseSync} = require('node:sqlite'), {importLegacyServices} = require('../../bin/lake-runtime/server.cjs');
  await fs.mkdir(join(f.home, 'secrets'), {mode: 0o700});
  const ref = 'legacy-db.json', secret = JSON.stringify({username: 'reader', password: 'synthetic-legacy-only'});
  await fs.writeFile(join(f.home, 'secrets', ref), secret, {mode: 0o600});
  const path = join(f.home, 'data/lake-web.sqlite'), db = new DatabaseSync(path);
  db.exec('CREATE TABLE resources(id TEXT,projectId TEXT,kind TEXT); CREATE TABLE resourceConnections(resourceId TEXT,config TEXT);');
  for (const [id, kind, settings] of [
    ['pg-legacy', 'database', {driver: 'postgres', host: '127.0.0.1', port: 5432, username: 'reader', sslmode: 'disable', credentialRef: ref}],
    ['redis-legacy', 'redis', {host: '127.0.0.1', port: 6379, tls: false, credentialRef: ref}],
    ['pg-unsupported-tls', 'database', {driver: 'postgres', host: '127.0.0.1', username: 'reader', sslmode: 'require', credentialRef: ref}],
  ]) {
    db.prepare('INSERT INTO resources VALUES(?,?,?)').run(id, f.project.id, kind);
    db.prepare('INSERT INTO resourceConnections VALUES(?,?)').run(id, JSON.stringify(settings));
    f.app.store.put('resources', id, {id, projectId: f.project.id, kind, name: id, settings: {}, status: 'unavailable'});
    f.app.store.put('legacyResources', id, {originalStatus: 'available'});
  }
  db.close(); await fs.chmod(path, 0o600); const before = await fs.readFile(path);
  await importLegacyServices(f.app.store, f.app.services);
  const pg = f.app.store.require('resources', 'pg-legacy'), redis = f.app.store.require('resources', 'redis-legacy');
  assert.equal(pg.settings.credentialRef, ref); assert.equal(redis.settings.credentialRef, ref);
  assert.equal(pg.settings.sslmode, 'disable'); assert.equal(pg.settings.tls, false);
  assert.equal(pg.status, 'available'); assert.equal(redis.status, 'available');
  assert.equal(f.app.store.require('resources', 'pg-unsupported-tls').status, 'unavailable');
  assert.ok(f.app.store.get('legacyServiceConnectionErrors', 'pg-unsupported-tls'));
  f.app.store.put('resources', pg.id, {...pg, settings: {...pg.settings, host: 'later-user-edit.test'}});
  await importLegacyServices(f.app.store, f.app.services);
  assert.equal(f.app.store.require('resources', pg.id).settings.host, 'later-user-edit.test');
  assert.deepEqual(await fs.readFile(path), before); assert.equal(await fs.readFile(join(f.home, 'secrets', ref), 'utf8'), secret);
  assert.deepEqual(await secretFiles(f.home), []); assert.ok(!JSON.stringify(f.app.store.list('resources')).includes('synthetic-legacy-only'));
});

test("all six service types save private configuration under the requested directory without network I/O", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const endpoint = await http(t, (_q, r) => {
    requests++;
    r.end("{}");
  });
  f.app.store.put("tree", "folder", {
    id: "folder",
    projectId: f.project.id,
    kind: "folder",
    parentId: null,
    name: "服务目录",
    resourceId: null,
    position: 0,
  });
  const rows = [
    input(
      "database",
      {
        driver: "mysql",
        host: "127.0.0.1",
        username: "reader",
        password: "mysql-fixture-only",
        tls: false,
      },
      "MySQL",
    ),
    input(
      "database",
      {
        driver: "postgres",
        host: "127.0.0.1",
        username: "reader",
        password: "pg-fixture-only",
      },
      "PostgreSQL",
    ),
    input("redis", { host: "127.0.0.1", password: "redis-fixture-only" }),
    input("apisix", { endpoint, apiKey: "apisix-fixture-only" }),
    input("prometheus", {
      endpoint,
      username: "reader",
      authMethod: "basic",
      password: "prom-fixture-only",
    }),
    input("victoriametrics", {
      endpoint: endpoint + "/select/2/prometheus",
      authMethod: "bearer",
      token: "vm-fixture-only",
    }),
  ];
  for (const row of rows) {
    const resource = await f.api(f.path, "POST", {
      ...row,
      parentId: "folder",
    });
    assert.equal(resource.name, row.name);
    assert.equal(resource.configurationRevision, 1);
    assert.equal(f.app.store.require("tree", resource.id).parentId, "folder");
    const ref = resource.settings.credentialRef;
    assert.ok(ref);
    assert.equal(
      (await fs.stat(join(f.home, "secrets", ref))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await f.api("/api/resources/" + resource.id)).id,
      resource.id,
    );
    for (const value of Object.values(row.settings))
      if (typeof value === "string" && value.endsWith("-fixture-only"))
        assert.ok(!JSON.stringify(resource).includes(value));
  }
  assert.equal(requests, 0);
  assert.equal((await secretFiles(f.home)).length, 6);
  const persisted = f.app.store
    .list("resources")
    .filter((r) => r.kind !== "local");
  await f.app.close();
  const again = await startLakeServer({
    home: f.home,
    data: join(f.home, "data"),
    staticRoot: join(f.home, "web"),
    port: 0,
  });
  t.after(() => again.close());
  for (const resource of persisted) {
    assert.deepEqual(again.store.require("resources", resource.id), resource);
    assert.equal(again.store.require("tree", resource.id).parentId, "folder");
  }
});

test("invalid service creation and failed persistence leave no secrets, resource or leaf", async (t) => {
  const f = await fixture(t),
    before = f.app.store.list("resources").length;
  for (const row of [
    input("redis", { host: "bad/path", password: "private" }),
    input("redis", { host: "localhost", port: 1.5, password: "private" }),
    input("apisix", {
      endpoint: "https://user:pass@example.test",
      apiKey: "private",
    }),
    input("prometheus", { endpoint: "https://example.test?token=secret" }),
    input("prometheus", {
      endpoint: "https://example.test",
      username: "reader",
      password: "private",
      token: "other",
    }),
    input("redis", { host: "localhost", credentialRef: "foreign.json" }),
    input("redis", { host: "localhost", password: "bad\nvalue" }),
    {
      ...input("redis", { host: "localhost", password: "private" }),
      parentId: "missing",
    },
  ])
    await f.api(f.path, "POST", row, 400);
  assert.equal(f.app.store.list("resources").length, before);
  assert.deepEqual(await secretFiles(f.home), []);
  const put = f.app.store.put.bind(f.app.store);
  f.app.store.put = (kind, ...args) => {
    if (kind === "tree") throw new Error("fixture storage failure");
    return put(kind, ...args);
  };
  try {
    await f.api(
      f.path,
      "POST",
      input("redis", { host: "localhost", password: "private" }),
      500,
    );
  } finally {
    f.app.store.put = put;
  }
  assert.equal(f.app.store.list("resources").length, before);
  assert.deepEqual(await secretFiles(f.home), []);
});

test("service edits retain or explicitly replace/clear secrets and only committed configuration changes advance revisions", async (t) => {
  const f = await fixture(t),
    resource = await f.api(
      f.path,
      "POST",
      input("redis", { host: "localhost", password: "first-fixture-only" }),
    ),
    path = "/api/resources/" + resource.id;
  const renamed = await f.api(path, "PATCH", {
    name: "renamed",
    settings: { password: "" },
  });
  assert.equal(renamed.settings.credentialRef, resource.settings.credentialRef);
  assert.equal(renamed.configurationRevision, 1);
  assert.equal(f.app.store.require("tree", resource.id).name, "renamed");
  await f.api(
    path,
    "PATCH",
    { settings: { port: -1, password: "invalid-new-secret" } },
    400,
  );
  assert.equal(f.app.store.get("resourceRevisions", resource.id), 1);
  assert.equal((await secretFiles(f.home)).length, 1);
  const rotated = await f.api(path, "PATCH", {
    settings: { password: "second-fixture-only" },
  });
  assert.equal(rotated.configurationRevision, 2);
  assert.notEqual(
    rotated.settings.credentialRef,
    resource.settings.credentialRef,
  );
  const cleared = await f.api(path, "PATCH", {
    settings: { clearCredential: true },
  });
  assert.equal(cleared.configurationRevision, 3);
  assert.equal(cleared.settings.credentialRef, undefined);
  assert.deepEqual(await secretFiles(f.home), []);
  const other = f.app.store.createProject("foreign"),
    foreign = await f.api(
      "/api/projects/" + other.id + "/resources",
      "POST",
      input("redis", { host: "localhost", password: "foreign-fixture-only" }),
    );
  await f.api(
    path,
    "PATCH",
    { settings: { credentialRef: foreign.settings.credentialRef } },
    400,
  );
  await f.api(
    f.path + "/test",
    "POST",
    { kind: "redis", resourceId: foreign.id, revision: 1 },
    404,
  );
});

test("HTTP service probes use fixed read-only protocols, exact authentication and VM tenant prefixes without saving drafts", async (t) => {
  const f = await fixture(t),
    seen = [];
  const endpoint = await http(t, (q, r) => {
    seen.push({
      url: q.url,
      key: q.headers["x-api-key"],
      authorization: q.headers.authorization,
      method: q.method,
    });
    r.setHeader("Content-Type", "application/json");
    r.end(
      q.url.includes("plugins/list")
        ? '["proxy-rewrite"]'
        : JSON.stringify({
            status: "success",
            data: { resultType: "scalar", result: [1, "1"] },
          }),
    );
  });
  for (const row of [
    input("apisix", { endpoint, apiKey: "key-fixture-only" }),
    input("prometheus", {
      endpoint,
      username: "reader",
      password: "password-fixture-only",
      authMethod: "basic",
    }),
    input("victoriametrics", {
      endpoint: endpoint + "/select/2/prometheus",
      token: "token-fixture-only",
      authMethod: "bearer",
    }),
  ]) {
    const result = await f.api(f.path + "/test", "POST", row);
    assert.equal(result.protocol, row.kind);
    assert.ok(result.testedAt);
    assert.match(result.message, /检查通过/);
  }
  assert.deepEqual(
    seen.map((v) => v.url),
    [
      "/apisix/admin/plugins/list",
      "/api/v1/query?query=1",
      "/select/2/prometheus/api/v1/query?query=1",
    ],
  );
  assert.equal(seen[0].key, "key-fixture-only");
  assert.equal(
    seen[1].authorization,
    "Basic " + Buffer.from("reader:password-fixture-only").toString("base64"),
  );
  assert.equal(seen[2].authorization, "Bearer token-fixture-only");
  assert.ok(seen.every((v) => v.method === "GET"));
  assert.deepEqual(await secretFiles(f.home), []);
  const saved = await f.api(
    f.path,
    "POST",
    input("apisix", { endpoint, apiKey: "saved-fixture-only" }),
  );
  await f.api(f.path + "/test", "POST", {
    kind: "apisix",
    settings: { apiKey: "" },
    resourceId: saved.id,
    revision: 1,
  });
  assert.equal(seen.at(-1).key, "saved-fixture-only");
  await f.api(
    f.path + "/test",
    "POST",
    { kind: "apisix", settings: {}, resourceId: saved.id, revision: 0 },
    409,
  );
});

test("HTTP redirects, wrong protocols and raw service errors never expose or forward credentials", async (t) => {
  const f = await fixture(t);
  let targetRequests = 0;
  const target = await http(t, (_q, r) => {
    targetRequests++;
    r.end("[]");
  });
  const origin = await http(t, (_q, r) => {
    r.writeHead(302, { Location: target });
    r.end();
  });
  await f.api(
    f.path + "/test",
    "POST",
    input("apisix", { endpoint: origin, apiKey: "private-fixture-only" }),
    502,
  );
  assert.equal(targetRequests, 0);
  for (const payload of [
    "<html>login</html>",
    '{"status":"success","data":{}}',
    '{"status":"success","data":{"resultType":"scalar"}}',
    '{"status":"success","data":{"resultType":"scalar","result":[1,"0"]}}',
    '{"status":"error","error":"private-fixture-only"}',
  ]) {
    const endpoint = await http(t, (_q, r) => r.end(payload));
    const result = await f.api(
      f.path + "/test",
      "POST",
      input("prometheus", {
        endpoint,
        authMethod: "bearer",
        token: "private-fixture-only",
      }),
      502,
    );
    assert.ok(!JSON.stringify(result).includes("private-fixture-only"));
  }
});

test("changing saved settings during a probe invalidates its late result and cancellation closes a pending read", async (t) => {
  const f = await fixture(t);
  let started, release;
  const arrived = new Promise((ok) => (started = ok)),
    gate = new Promise((ok) => (release = ok));
  const endpoint = await http(t, async (_q, r) => {
    started();
    await gate;
    r.end("[]");
  });
  const resource = await f.api(f.path, "POST", input("apisix", { endpoint }));
  const pending = f.api(
    f.path + "/test",
    "POST",
    { kind: "apisix", settings: {}, resourceId: resource.id, revision: 1 },
    409,
  );
  await arrived;
  await f.api("/api/resources/" + resource.id, "PATCH", {
    settings: { endpoint: endpoint + "/changed" },
  });
  release();
  await pending;
  let start;
  const waiting = new Promise((ok) => (start = ok)),
    hang = await http(t, (_q, _r) => start());
  const cancel = new AbortController();
  const work = f.app.services.test(
    f.project.id,
    input("apisix", { endpoint: hang }),
    cancel.signal,
  );
  await waiting;
  cancel.abort();
  await assert.rejects(work, /取消或超时/);
});

test("MySQL connection probe runs only a constant SELECT with the actual mysql2 client", async (t) => {
  const wire = await mysqlServer(t, (connection, sql) => {
      assert.equal(sql, "SELECT 1 AS lake_connection_test");
      connection.writeTextResult(
        [{ lake_connection_test: 1 }],
        [{ name: "lake_connection_test" }],
      );
    }),
    f = await fixture(t);
  const result = await f.api(
    f.path + "/test",
    "POST",
    input("database", {
      driver: "mysql",
      host: "127.0.0.1",
      port: wire.port,
      username: "reader",
      password: "fixture",
      tls: false,
    }),
  );
  assert.equal(result.protocol, "mysql");
  assert.deepEqual(wire.queries, ["SELECT 1 AS lake_connection_test"]);
});

test("PostgreSQL probe authenticates with the supplied credentials and never adopts ambient passwords", async (t) => {
  const f = await fixture(t),
    passwords = [],
    queries = [],
    startups = [],
    sockets = new Set();
  const int = (n) => {
      const b = Buffer.alloc(4);
      b.writeInt32BE(n);
      return b;
    },
    packet = (type, body) =>
      Buffer.concat([Buffer.from(type), int(body.length + 4), body]);
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0),
      startup = true;
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= (startup ? 4 : 5)) {
        const length = buffer.readInt32BE(startup ? 0 : 1),
          size = length + (startup ? 0 : 1);
        if (buffer.length < size) return;
        const message = buffer.subarray(0, size);
        buffer = buffer.subarray(size);
        if (startup) {
          startups.push(message.subarray(8).toString());
          startup = false;
          socket.write(packet("R", int(3)));
        } else if (message[0] === 112) {
          passwords.push(message.subarray(5, -1).toString());
          socket.write(
            Buffer.concat([packet("R", int(0)), packet("Z", Buffer.from("I"))]),
          );
        } else if (message[0] === 81) {
          queries.push(message.subarray(5, -1).toString());
          socket.write(
            Buffer.concat([
              packet("C", Buffer.from("SELECT 1\0")),
              packet("Z", Buffer.from("I")),
            ]),
          );
        } else if (message[0] === 88) socket.end();
      }
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(
    () =>
      new Promise((ok) => {
        for (const socket of sockets) socket.destroy();
        server.close(ok);
      }),
  );
  const previous = process.env.PGPASSWORD;
  process.env.PGPASSWORD = "must-not-use-ambient-password";
  try {
    for (const password of ["explicit-fixture-only", ""])
      await f.api(
        f.path + "/test",
        "POST",
        input("database", {
          driver: "postgres",
          host: "127.0.0.1",
          port: server.address().port,
          username: "reader",
          password,
          tls: false,
        }),
      );
  } finally {
    if (previous === undefined) delete process.env.PGPASSWORD;
    else process.env.PGPASSWORD = previous;
  }
  assert.deepEqual(passwords, ["explicit-fixture-only", ""]);
  assert.deepEqual(queries, [
    "SELECT 1 AS lake_connection_test",
    "SELECT 1 AS lake_connection_test",
  ]);
  assert.ok(
    startups.every((value) =>
      value.includes("default_transaction_read_only=on"),
    ),
  );
});

test(
  "Redis probe authenticates and selects the database using a real isolated Redis server",
  { skip: !existsSync("/opt/homebrew/bin/redis-server") },
  async (t) => {
    const f = await fixture(t),
      reserve = net.createServer();
    await new Promise((ok) => reserve.listen(0, "127.0.0.1", ok));
    const port = reserve.address().port;
    await new Promise((ok) => reserve.close(ok));
    const config = join(f.home, "redis.conf");
    await fs.writeFile(
      config,
      `bind 127.0.0.1\nport ${port}\nsave ""\nappendonly no\nrequirepass redis-fixture-only\ndir ${f.home}\n`,
      { mode: 0o600 },
    );
    const child = spawn("/opt/homebrew/bin/redis-server", [config], {
      stdio: "ignore",
    });
    t.after(async () => {
      if (child.exitCode === null) {
        const ended = new Promise((ok) => child.once("exit", ok));
        child.kill("SIGTERM");
        await ended;
      }
    });
    for (let i = 0; i < 100; i++) {
      try {
        await new Promise((ok, fail) => {
          const socket = net.connect(port, "127.0.0.1", () => {
            socket.destroy();
            ok();
          });
          socket.once("error", fail);
        });
        break;
      } catch {
        await new Promise((ok) => setTimeout(ok, 20));
      }
    }
    const result = await f.api(
      f.path + "/test",
      "POST",
      input("redis", {
        host: "127.0.0.1",
        port,
        password: "redis-fixture-only",
        db: 2,
        tls: false,
      }),
    );
    assert.equal(result.protocol, "redis");
    await f.api(
      f.path + "/test",
      "POST",
      input("redis", {
        host: "127.0.0.1",
        port,
        password: "wrong-fixture-only",
        tls: false,
      }),
      502,
    );
  },
);

test("unsafe credential files and an in-place credential change invalidate saved probes", async (t) => {
  const f = await fixture(t);
  let arrive, release;
  const started = new Promise((ok) => (arrive = ok)),
    gate = new Promise((ok) => (release = ok));
  const endpoint = await http(t, async (_q, r) => {
    arrive();
    await gate;
    r.end("[]");
  });
  const resource = await f.api(
    f.path,
    "POST",
    input("apisix", { endpoint, apiKey: "first-fixture-only" }),
  );
  const path = join(f.home, "secrets", resource.settings.credentialRef);
  const pending = f.api(
    f.path + "/test",
    "POST",
    { kind: "apisix", settings: {}, resourceId: resource.id, revision: 1 },
    409,
  );
  await started;
  await fs.writeFile(path, JSON.stringify({ apiKey: "rotated-fixture-only" }), {
    mode: 0o600,
  });
  release();
  await pending;
  await fs.chmod(path, 0o644);
  await f.api(
    f.path + "/test",
    "POST",
    { kind: "apisix", settings: {}, resourceId: resource.id, revision: 1 },
    409,
  );
  await fs.chmod(path, 0o600);
  await fs.rename(path, path + ".old");
  await fs.symlink(path + ".old", path);
  await f.api(
    f.path + "/test",
    "POST",
    { kind: "apisix", settings: {}, resourceId: resource.id, revision: 1 },
    409,
  );
});
