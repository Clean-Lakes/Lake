import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { DaemonClient } from "../../src/surfaces/daemon-client.js";
test("daemon replacement refreshes credentials and retries a POST with the same request ID", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "lake-reconnect-"));
  await mkdir(join(home, "agent/runtime"), { recursive: true });
  let origin = "",
    token = "first",
    lost = false,
    executions = 0;
  const ids: string[] = [],
    receipts = new Map<string, any>();
  const server = createServer(async (req, res) => {
    if (req.url === "/api/v1/health") {
      res.end(JSON.stringify({ nonce: "next" }));
      return;
    }
    if (req.headers.authorization !== "Bearer " + token) {
      res
        .writeHead(403)
        .end(
          JSON.stringify({
            error: { code: "unauthorized", message: "unauthorized" },
          }),
        );
      return;
    }
    if (req.method === "GET") {
      res.end(JSON.stringify({ reconnected: true }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const command = JSON.parse(raw);
    ids.push(command.requestId);
    if (!receipts.has(command.requestId)) {
      executions++;
      receipts.set(command.requestId, { actionId: "created-once" });
    }
    if (!lost) {
      lost = true;
      token = "next";
      await writeFile(
        join(home, "agent/runtime/daemon.json"),
        JSON.stringify({ origin, token, nonce: "next", pid: process.pid }),
        { mode: 0o600 },
      );
      req.socket.destroy();
    } else res.end(JSON.stringify(receipts.get(command.requestId)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(home, { recursive: true, force: true });
  });
  const client = new DaemonClient(
    { origin, token, nonce: "first", pid: process.pid },
    home,
  );
  const id = crypto.randomUUID();
  const result = await client.request("POST", "actions", { safe: true }, 0, id);
  assert.equal(result.actionId, "created-once");
  assert.equal(executions, 1);
  assert.deepEqual(ids, [id, id]);
  assert.equal(client.info.token, "next");
  const old = new DaemonClient(
    { origin, token: "stale", nonce: "first", pid: process.pid },
    home,
  );
  assert.equal((await old.request("GET", "sessions")).reconnected, true);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    old.request("POST", "actions", {}, 0, crypto.randomUUID(), aborted.signal),
    { code: "cancelled" },
  );
  assert.equal(executions, 1);
});
