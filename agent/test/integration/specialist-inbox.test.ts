import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testHome } from "../fixtures/home.js";
import { addSession } from "../fixtures/session.js";
import { InboxService } from "../../src/specialists/inbox.js";
test("acknowledged inbox instructions remain recoverable after a failed model request", async (t) => {
  const h = await testHome();
  t.after(() => h.close());
  const { session } = await addSession(h),
    inbox = new InboxService(h.store);
  const a = randomUUID(),
    b = randomUUID();
  await inbox.deliver(session.id, session.id, "Keep the scope read-only", a);
  await inbox.deliver(
    session.id,
    session.id,
    "Use the updated verification criteria",
    b,
  );
  await inbox.deliver(session.id, session.id, "Duplicate must be ignored", a);
  await inbox.ack([a, b]);
  assert.equal((await inbox.pending(session.id)).length, 0);
  assert.deepEqual(
    (await inbox.history(session.id)).map((m) => m.text),
    ["Keep the scope read-only", "Use the updated verification criteria"],
  );
});
