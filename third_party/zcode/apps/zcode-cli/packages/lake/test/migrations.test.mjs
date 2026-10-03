import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { LakeDatabase, SCHEMA_VERSION } from "../dist/adapters/storage/database.js";
import { LakeData } from "../dist/adapters/storage/data.js";

for (let version = 1; version <= 16; version++) {
  test(`legacy schema ${version} preserves data and authority`, async () => {
    const root = await mkdtemp(join(tmpdir(), "lake-ts-migration-"));
    const file = join(root, "lake.db");
    await copyFile(new URL(`./fixtures/migrations/v${String(version).padStart(2, "0")}.db`, import.meta.url), file);
    let data;
    try {
      data = new LakeData(await LakeDatabase.open(root));
      const lake = await data.request("lake.get", { lake: "样本湖" });
      assert.equal(lake.id, "fixture-lake");
      const host = await data.request("res.get", { resource: "fixture-host" });
      assert.equal(host.ssh.host, "example.invalid");
      assert.equal(host.execute_authz, false);
      const policy = await data.request("permissions.get", {});
      assert.equal(policy.silent_ssh_command, false);
      if (version >= 2) assert.equal(policy.silent_ssh_read, false);
      if (version >= 3) {
        const history = await data.request("conversation.show", { id: "fixture-conversation" });
        assert.equal(history.turns[0].prompt, "检查样本");
        assert.equal(history.turns[0].answer, "已检查");
        assert.equal(history.events.length, 2);
        assert.equal(history.events[0].legacy_turn_id, "fixture-turn");
        if (version >= 7) assert.equal(history.turns[0].specialists[0].id, "legacy-specialist");
      }
      data.close(); data = undefined;
      const db = new DatabaseSync(file);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(db.prepare("SELECT COUNT(*) count FROM attach WHERE ref='file:ssh/fixture-only'").get().count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) count FROM code_workspace WHERE authorized=1").get().count, 0);
      if (version >= 5) assert.equal(db.prepare("SELECT COUNT(*) count FROM ops_workflow WHERE id='fixture-workflow'").get().count, 1);
      db.exec("INSERT INTO journal(ts,action_id,actor,target_path,tool,risk,event) VALUES(0,'fixture','cli','样本湖/样本主机','fixture','read','completed')");
      assert.throws(() => db.exec("UPDATE journal SET detail='changed'"), /append-only/u);
      assert.throws(() => db.exec("DELETE FROM journal"), /append-only/u);
      db.close();
      const backups = (await readdir(root)).filter(path => path.endsWith(".bak"));
      assert.equal(backups.length, 1);
      assert.equal((await lstat(join(root, backups[0]))).mode & 0o777, 0o600);
      data = new LakeData(await LakeDatabase.open(root)); data.close(); data = undefined;
      assert.equal((await readdir(root)).filter(path => path.endsWith(".bak")).length, 1);
    } finally { data?.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("future schema is rejected and failed migration preserves a private backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "lake-ts-failed-"));
  try {
    const file = join(root, "lake.db");
    await copyFile(new URL("./fixtures/migrations/v15.db", import.meta.url), file);
    const blocker = new DatabaseSync(file);
    blocker.exec("CREATE TABLE code_workspace(blocker INTEGER)"); blocker.close();
    await assert.rejects(LakeDatabase.open(root), /already exists/u);
    const backups = (await readdir(root)).filter(path => path.endsWith(".bak"));
    assert.equal(backups.length, 1);
    for (const path of [file, join(root, backups[0])]) {
      const db = new DatabaseSync(path);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 15); db.close();
      assert.equal((await lstat(path)).mode & 0o777, 0o600);
    }
    const future = new DatabaseSync(file); future.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`); future.close();
    await assert.rejects(LakeDatabase.open(root), /newer than supported/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("schema 17 and 19 repair their historically optional columns", async () => {
  for (const [version, table, column] of [[16, "conversation_event", "tool_call_id"], [18, "conversation_summary", "task_state"]]) {
    const root = await mkdtemp(join(tmpdir(), "lake-ts-repair-"));
    try {
      (await LakeDatabase.open(root)).close();
      const db = new DatabaseSync(join(root, "lake.db"));
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}; PRAGMA user_version=${version}`); db.close();
      (await LakeDatabase.open(root)).close();
      const checked = new DatabaseSync(join(root, "lake.db"));
      assert(checked.prepare(`PRAGMA table_info(${table})`).all().some(field => field.name === column)); checked.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
