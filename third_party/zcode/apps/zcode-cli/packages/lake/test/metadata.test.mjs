import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LakeDatabase } from "../dist/adapters/storage/database.js";
import { LakeData } from "../dist/adapters/storage/data.js";
import { nextSchedule } from "../dist/domain/schedule.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lake-metadata-")), db = await LakeDatabase.open(root), data = new LakeData(db);
  await data.request("lake.add", { name: "fixture" });
  const host = await data.request("res.add", { lake: "fixture", name: "host", spec: { ssh: { host: "example.invalid", username: "fixture" } } });
  await data.request("res.authorize", { resource: host.id, allow: true });
  return { root, db, data, host, close: async () => { data.close(); await rm(root, { recursive: true, force: true }); } };
}
test("specialist digest lifecycle, extension disabling on changed declarations and immutable scripts", async () => {
  const f = await fixture();
  try {
    const hash = "1".repeat(64), id = "fixture-task";
    await f.data.request("specialist.create", { id, parent_run_id: "fixture", name: "ops", model: "fixture", scope: { resource_ids: [f.host.id] }, request_sha256: hash });
    await assert.rejects(f.data.request("specialist.update", { id, status: "completed", response_sha256: hash }));
    await f.data.request("specialist.update", { id, status: "running" });
    await assert.rejects(f.data.request("specialist.update", { id, status: "completed" }));
    await f.data.request("specialist.interrupted", { parent_run_id: "fixture" });
    assert.equal((await f.data.request("specialist.get", { id })).status, "unknown");
    await f.data.request("specialist.resume", { id }); await f.data.request("specialist.update", { id, status: "completed", response_sha256: hash });
    await assert.rejects(f.data.request("specialist.resume", { id }));
    const plugin = { name: "fixture-plugin", version: "1", source: f.root, sha256: hash, install_path: f.root, manifest_json: { name: "fixture" } };
    await f.data.request("plugin.save", plugin); await f.data.request("plugin.enable", { name: plugin.name, enabled: true });
    assert.equal((await f.data.request("plugin.save", { ...plugin, version: "2" })).enabled, false);
    const hook = { workspace_path: f.root, sha256: hash };
    await f.data.request("hook.save", hook); await f.data.request("hook.enable", { ...hook, enabled: true });
    assert.equal((await f.data.request("hook.save", hook)).enabled, true);
    assert.equal((await f.data.request("hook.save", { ...hook, sha256: "2".repeat(64) })).enabled, false);
    await assert.rejects(f.data.request("hook.enable", { ...hook, enabled: true }));
    const script = await f.data.request("script.save", { lake: "fixture", name: "fixture-script", language: "sh", content: "echo fixture" });
    assert.equal((await f.data.request("script.read", { id: script.id })).content, "echo fixture");
    await writeFile(join(f.root, script.path), "echo changed"); await assert.rejects(f.data.request("script.read", { id: script.id }), /SHA-256/u);
    const before = f.db.all("SELECT COUNT(*) total FROM journal")[0].total;
    await assert.rejects(f.data.request("lake.add", { name: "fixture" })); assert.equal(f.db.all("SELECT COUNT(*) total FROM journal")[0].total, before, "failed mutation must not leave a successful audit");
  } finally { await f.close(); }
});
test("cron matches DST absolute time, numeric grammar and day/week OR compatibility", () => {
  assert.equal(nextSchedule("cron", "30 1 * * *", "America/New_York", Date.parse("2026-11-01T05:31:00Z")), Date.parse("2026-11-01T06:30:00Z"));
  assert.equal(nextSchedule("cron", "0 9 * * *", "Asia/Shanghai", Date.parse("2026-10-01T00:00:00Z")), Date.parse("2026-10-01T01:00:00Z"));
  assert.throws(() => nextSchedule("cron", "1a * * * *", "UTC", Date.now()));
  assert.throws(() => nextSchedule("once", "2026-01-01", "UTC", Date.now()));
});
test("schedule claims are unique, grants roll back atomically and expired dispatched runs pause", async () => {
  const f = await fixture(), second = new LakeData(await LakeDatabase.open(f.root));
  try {
    const now = Date.now(), spec = { version: 2, name: "fixture-workflow", nodes: [{ id: "one", kind: "ssh_command", target: { type: "string", literal: "host" }, command: { type: "string", literal: "echo fixture" } }] };
    const def = await f.data.request("workflow.v2.save", { lake: "fixture", spec });
    const schedule = await f.data.request("schedule.create", { workflow_id: def.id, kind: "once", expression: new Date(now + 10000).toISOString(), timezone: "UTC", now_ms: now });
    const grant = await f.data.request("schedule.grant", { id: schedule.id, node_id: "one", resource: f.host.id, command_sha256: "1".repeat(64), expires_ms: now + 100000, max_runs: 1 });
    const call = { node_id: "one", resource_id: f.host.id, command_sha256: "1".repeat(64) };
    await assert.rejects(f.data.request("schedule.consume", { id: schedule.id, revision: 1, calls: [call, { ...call, node_id: "absent" }], now_ms: now }));
    assert.equal(f.db.one("SELECT used_runs FROM schedule_grant WHERE id=?", grant.id).used_runs, 0);
    await f.data.request("schedule.consume", { id: schedule.id, revision: 1, calls: [call], now_ms: now });
    await assert.rejects(f.data.request("schedule.consume", { id: schedule.id, revision: 1, calls: [call], now_ms: now }));
    const claimed = await f.data.request("schedule.claim", { owner: "one", now_ms: now + 11000, lease_ms: 1000 });
    assert.equal(await second.request("schedule.claim", { owner: "two", now_ms: now + 11000 }), null);
    await assert.rejects(second.request("schedule.update_run", { id: claimed.run.id, owner: "two", status: "running", now_ms: now + 11000 }));
    await f.data.request("schedule.update_run", { id: claimed.run.id, owner: "one", status: "running", now_ms: now + 11000 });
    assert.equal(await second.request("schedule.expire", { now_ms: now + 13000 }), 1);
    assert.equal((await second.request("schedule.get", { id: schedule.id })).enabled, false);
    assert.equal((await second.request("schedule.run", { id: claimed.run.id })).status, "unknown");
    assert.equal(await second.request("schedule.claim", { owner: "two", now_ms: now + 14000 }), null);
  } finally { second.close(); await f.close(); }
});
