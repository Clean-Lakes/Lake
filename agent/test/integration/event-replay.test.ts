import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testApplication } from "../fixtures/application.js";
import { SessionStore } from "../../ui/src/state/session-store.js";
test("snapshot cursor and event replay converge, duplicate events are harmless", async (t) => {
  const h = await testApplication();
  t.after(() => h.close());
  const id = randomUUID();
  await h.app.importResources({
    resources: [
      {
        id,
        lakeId: h.lakeId,
        environmentId: h.environmentId,
        kind: "http",
        name: "Fixture",
        endpoint: "http://127.0.0.1:1",
        identity: "fixture",
      },
    ],
  });
  const session = await h.app.createSession({
    lakeId: h.lakeId,
    environmentId: h.environmentId,
    objective: "Inspect",
    resourceIds: [id],
  });
  const snapshot: any = await h.app.data.snapshot(session.id);
  const store = new SessionStore();
  store.applySnapshot(snapshot);
  const resource = await h.app.store.get<any>("resources", id);
  await h.app.sessions.open(session.id, resource, "http-health");
  const events = await h.app.events.replay(
    `session:${session.id}`,
    snapshot.cursor,
  );
  for (const event of events) assert.equal(store.applyEvent(event), "applied");
  const gap=new SessionStore();gap.applySnapshot(snapshot);assert.equal(gap.applyEvent(events.at(-1)!),events.length>1?'gap':'applied');gap.applySnapshot(await h.app.data.snapshot(session.id) as any);assert.equal(gap.snapshot!.cursor,(await h.app.data.snapshot(session.id) as any).cursor);
  assert.equal(store.applyEvent(events[0]!), "duplicate");
  const fresh: any = await h.app.data.snapshot(session.id);
  assert.deepEqual(
    store.snapshot?.execution_sessions,
    fresh.execution_sessions,
  );
  assert.equal(store.snapshot?.cursor, fresh.cursor);
});
