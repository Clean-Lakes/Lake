import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LakeDatabase } from "../dist/adapters/storage/database.js";
import { LakeData } from "../dist/adapters/storage/data.js";
import { LakeApplication } from "../dist/app/runtime.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lake-ts-ops-"));
  const data = new LakeData(await LakeDatabase.open(root));
  await data.request("lake.add", { name: "测试湖" });
  await data.request("res.add", { lake: "测试湖", name: "测试主机", kind: "host", spec: { ssh: { host: "example.invalid", port: 22, username: "fixture" } }, credential_ref: "file:ssh/fixture-only" });
  await data.request("res.authorize", { resource: "测试湖/测试主机", allow: true });
  await data.request("permissions.set", { key: "ssh-read", enabled: false });
  const events = [], calls = [];
  const runtime = new LakeApplication({ data, settings: { request: async () => null }, options: { root }, id: () => "fixture-action", emit: event => events.push(event), execution: {
    request: async (method, params) => { calls.push({ method, params }); return { status: "completed", stdout: "fixture uptime", stderr: "", exit_code: 0, duration_ms: 1 }; }, close: async () => {},
  } });
  return { runtime, data, events, calls, cleanup: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 1));
  assert(predicate(), "expected event did not arrive");
}

test("selected lake → host query → approval → fixed read result → append-only journal", async () => {
  const f = await fixture();
  try {
    await f.runtime.dispatch({ method: "lake.use", params: { lake: "测试湖" } });
    assert.equal((await f.runtime.dispatch({ method: "res.list", params: { lake: "测试湖" } })).length, 1);
    const request = { method: "ops.read", id: "check-1", params: { resource: "测试湖/测试主机", check: "uptime" } };
    const pending = f.runtime.dispatch(request);
    await until(() => f.events.some(event => event.type === "approval"));
    assert.equal(f.calls.length, 0);
    await f.runtime.dispatch({ method: "approval.respond", params: { id: "check-1", approved: true } });
    assert.equal((await pending).stdout, "fixture uptime");
    assert.equal(f.calls[0].params.command, "uptime");
    assert.deepEqual((await f.data.request("journal.list", { action_id: "check-1" })).reverse().map(row => row.event), ["requested", "proposed", "approved", "started", "completed"]);
    assert.equal((await f.runtime.dispatch(request)).stdout, "fixture uptime");
    assert.equal(f.calls.length, 1, "duplicate ID must never dispatch twice");
  } finally { await f.cleanup(); }
});

test("authorization revocation during approval dispatches nothing", async () => {
  const f = await fixture();
  try {
    const pending = f.runtime.dispatch({ method: "ops.read", id: "revoked", params: { resource: "测试湖/测试主机", check: "uptime" } });
    const rejected = assert.rejects(pending, /授权或身份已改变/u);
    await until(() => f.events.length);
    await f.data.request("res.authorize", { resource: "测试湖/测试主机", allow: false });
    await f.runtime.dispatch({ method: "approval.respond", params: { id: "revoked", approved: true } });
    await rejected; assert.equal(f.calls.length, 0);
    assert.equal((await f.data.request("journal.list", { action_id: "revoked" }))[0].event, "denied");
  } finally { await f.cleanup(); }
});

test("cancellation discards an approval and cannot execute", async () => {
  const f = await fixture();
  try {
    const pending = f.runtime.dispatch({ method: "ops.read", id: "cancelled", params: { resource: "测试湖/测试主机", check: "uptime" } });
    const rejected = assert.rejects(pending);
    await until(() => f.events.length);
    await f.runtime.dispatch({ method: "execution.cancel", params: { id: "cancelled" } });
    await rejected; assert.equal(f.calls.length, 0);
    await assert.rejects(f.runtime.dispatch({ method: "approval.respond", params: { id: "cancelled", approved: true } }), /过期/u);
  } finally { await f.cleanup(); }
});
