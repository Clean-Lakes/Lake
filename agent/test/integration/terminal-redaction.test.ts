import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testApplication } from "../fixtures/application.js";
test("shared terminal storage redacts a credential across received chunks before persistence", async (t) => {
  const h = await testApplication(undefined, false);
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
  const s = await h.app.createSession({
      lakeId: h.lakeId,
      environmentId: h.environmentId,
      objective: "Terminal",
      resourceIds: [id],
    }),
    resource = await h.app.store.get<any>("resources", id),
    terminal = await h.app.sessions.open(s.id, resource, "http-health");
  const secret = "synthetic-" + randomUUID();
  h.app.redactor.register(secret);
  await h.app.output.appendStreamOutput(
    terminal.id,
    "before " + secret.slice(0, 10),
  );
  await h.app.output.appendStreamOutput(
    terminal.id,
    secret.slice(10) + " after",
  );
  await h.app.output.finishStream(terminal.id);
  const chunks = await h.app.sessions.read(s.id, terminal.id, "0");
  assert.equal(
    chunks.map((c: any) => c.text).join(""),
    "before [REDACTED] after",
  );
  assert(
    !JSON.stringify(await h.app.store.list("terminal_chunks")).includes(secret),
  );
});
