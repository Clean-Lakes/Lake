import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { testHome } from "../fixtures/home.js";
import { SqliteStore } from "../../src/storage/store.js";
import { backupDatabase } from "../../src/storage/backup.js";
import { eventCommand, EventStore } from "../../src/storage/events.js";
test("CAS conflicts roll back both state and event, foreign keys hold", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const lake = await h.store.get<any>("lakes", h.lakeId);
  const value = { ...lake, revision: 2, name: "Updated" };
  await h.store.transact([
    { op: "put", table: "lakes", value, expectedRevision: 1 },
    eventCommand("lake.created", value),
  ]);
  await assert.rejects(
    h.store.transact([
      eventCommand("lake.created", value),
      { op: "put", table: "lakes", value, expectedRevision: 1 },
    ]),
  );
  assert.equal(
    (await new EventStore(h.store).replay(`lake:${h.lakeId}`)).length,
    1,
  );
  await assert.rejects(
    h.store.transact([
      {
        op: "put",
        table: "environments",
        value: {
          id: randomUUID(),
          revision: 1,
          lakeId: randomUUID(),
          name: "Bad",
        },
        expectedRevision: 0,
      },
    ]),
  );
  const results = await Promise.allSettled([
    h.store.transact([
      {
        op: "put",
        table: "lakes",
        value: { ...value, revision: 3 },
        expectedRevision: 2,
      },
    ]),
    h.store.transact([
      {
        op: "put",
        table: "lakes",
        value: { ...value, revision: 3 },
        expectedRevision: 2,
      },
    ]),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});
test("SQLite backup includes committed WAL writes", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  await backupDatabase(h.store, join(h.agent, "backup.db"));
  const restored = new SqliteStore(join(h.agent, "backup.db"));
  t.after(() => restored.close());
  assert.equal((await restored.get<any>("lakes", h.lakeId)).name, "Test");
});
