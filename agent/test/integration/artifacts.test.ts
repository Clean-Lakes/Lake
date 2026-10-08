import test from "node:test";
import assert from "node:assert/strict";
import { writeFile,access } from "node:fs/promises";
import { join } from "node:path";
import { testHome } from "../fixtures/home.js";
import { CheckpointStore } from "../../src/storage/checkpoints.js";
test("artifacts enforce limits, hashes, paths and private checkpoint recovery", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const id = await h.artifacts.put("recorded evidence");
  assert.equal(await h.artifacts.read(id), "recorded evidence");
  await assert.rejects(h.artifacts.read("../config.json"));
  await writeFile(join(h.agent, "artifacts", id), "corrupted");
  await assert.rejects(h.artifacts.read(id));
  await assert.rejects(h.artifacts.put("x".repeat(10485761)));
  const checkpoints = new CheckpointStore(h.store, h.artifacts);
  const sessionId = crypto.randomUUID();
  await h.store.transact([
    {
      op: "put",
      table: "sessions",
      value: {
        id: sessionId,
        revision: 1,
        lakeId: h.lakeId,
        environmentId: h.environmentId,
      },
      expectedRevision: 0,
    },
  ]);
  const checkpoint = await checkpoints.save(sessionId, "fixture", {
    scope: ["safe"],
    inboxCursor: 2,
  });
  assert.deepEqual(await checkpoints.load(checkpoint), {
    scope: ["safe"],
    inboxCursor: 2,
  });
  const orphan=join(h.agent,'artifacts',crypto.randomUUID()+'.tmp');await writeFile(orphan,'uncommitted',{mode:0o600});await h.artifacts.cleanUnreferenced();await assert.rejects(access(orphan));assert.deepEqual(await checkpoints.load(checkpoint),{scope:['safe'],inboxCursor:2});
});
