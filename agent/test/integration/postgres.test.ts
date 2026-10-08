import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testHome } from "../fixtures/home.js";
import { runProcess } from "../../src/adapters/process.js";
import { PostgresAdapter } from "../../src/adapters/postgres.js";
import type { Resource } from "../../src/domain/entities.js";
test("real PostgreSQL runs only fixed read-only probes", async (t) => {
  const h = await testHome(),
    name = "lake-pg-" + randomUUID(),
    password = randomUUID();
  const envFile = join(h.root, "pg.env");
  await writeFile(
    envFile,
    `POSTGRES_USER=lake_fixture\nPOSTGRES_DB=lake_fixture\nPOSTGRES_PASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  const run = await runProcess(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--env-file",
      envFile,
      "-p",
      "127.0.0.1::5432",
      "postgres:16",
    ],
    { signal: new AbortController().signal, timeoutMs: 30000 },
  );
  assert.equal(run.exitCode, 0);
  t.after(async () => {
    await runProcess("docker", ["rm", "-f", name], {
      signal: new AbortController().signal,
    });
    await h.close();
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    const state = await runProcess(
      "docker",
      ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "lake_fixture"],
      { signal: new AbortController().signal },
    );
    if (state.exitCode === 0) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(ready);
  const info = await runProcess(
    "docker",
    [
      "inspect",
      "--format",
      '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
      name,
    ],
    { signal: new AbortController().signal },
  );
  await h.credentials.import(
    "database/fixture",
    Buffer.from(JSON.stringify({ user: "lake_fixture", password })),
  );
  const resource: Resource = {
    id: randomUUID(),
    revision: 1,
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    kind: "postgres",
    name: "PG fixture",
    endpoint: `postgresql://127.0.0.1:${info.stdout.trim()}/lake_fixture`,
    identity: "fixture-database",
    credentialRef: "database/fixture",
    settings: { tls: false, allowPlaintext: true },
  };
  const adapter = new PostgresAdapter(h.credentials);
  const health = await adapter.queryRead(
    resource,
    "health",
    new AbortController().signal,
  );
  assert.equal(health.status, "ok");
  assert.equal((health.data as any).rows[0].database, "lake_fixture");
  await assert.rejects(
    adapter.queryRead(
      resource,
      "DROP TABLE anything",
      new AbortController().signal,
    ),
  );
  const activity = await adapter.queryRead(
    resource,
    "activity",
    new AbortController().signal,
  );
  assert.equal(activity.status, "ok");
  assert(!JSON.stringify(health).includes(password));
});
