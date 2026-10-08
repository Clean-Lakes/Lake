import test from "node:test";
import { request } from "node:http";
import assert from "node:assert/strict";
import { testApplication } from "../fixtures/application.js";
import { createHttpServer } from "../../src/surfaces/http-server.js";
test("local HTTP API rejects missing auth, wrong origins and bootstrap replay", async (t) => {
  const h = await testApplication();
  const http = await createHttpServer(h.app);
  t.after(async () => {
    await http.close();
    await h.close();
  });
  assert.equal((await fetch(http.origin + "/api/v1/resources")).status, 403);
  const headers = { Authorization: "Bearer " + http.auth.token };
  assert.equal(
    (
      await fetch(http.origin + "/api/v1/resources", {
        headers: { ...headers, Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(http.origin + "/api/v1/resources", { headers })).status,
    200,
  );
  assert.equal(
    await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        http.origin + "/api/v1/resources",
        { headers: { ...headers, Host: "untrusted.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    }),
    403,
  );
  const oversized = await fetch(http.origin + "/api/v1/sessions", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "x".repeat(1048577) }),
  });
  assert.equal(oversized.status, 413);
  const expired = http.auth.issue();
  (http.auth as any).tickets.set(expired, Date.now() - 1);
  assert.throws(() => http.auth.exchange(expired));
  const ticket = http.auth.issue();
  const exchange = () =>
    fetch(http.origin + "/api/v1/bootstrap/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
  const response = await exchange();
  assert.equal(response.status, 200);
  assert(response.headers.get("set-cookie")?.includes("HttpOnly"));
  assert.equal((await exchange()).status, 403);
  assert.equal(
    (await fetch(http.origin + "/api/v1/bootstrap/session")).status,
    403,
  );
});
