import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  copyDataDirectory,
  getAppConfigDir,
  getLakeAgentSessionDbPath,
  getTasksIndexDatabasePath,
  getZCodeDataRootDir,
  setDataBaseDir,
} from "../src/paths.js";
import { getSettingsFilePath } from "../src/setting/settingService.js";

test("Lake task index and Agent session database share one Lake-only data root", () => {
  const baseDir = join(process.cwd(), "test-lake-base");
  setDataBaseDir(baseDir);
  try {
    assert.equal(getZCodeDataRootDir(), join(baseDir, ".lake"));
    assert.equal(getAppConfigDir(), join(baseDir, ".lake", "v2"));
    assert.equal(getTasksIndexDatabasePath(), join(baseDir, ".lake", "v2", "tasks-index.sqlite"));
    assert.equal(getLakeAgentSessionDbPath(), join(baseDir, ".lake", "cli", "db", "db.sqlite"));
  } finally {
    setDataBaseDir(null);
  }
});

test("Lake data-root migration copies only .lake/v2 and never creates .zcode", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "lake-data-root-migration-"));
  const oldBaseDir = join(fixtureRoot, "old");
  const newBaseDir = join(fixtureRoot, "new");
  const lakePayloadPath = join(oldBaseDir, ".lake", "v2", "tasks-index.sqlite");
  const zcodeSentinelPath = join(oldBaseDir, ".zcode", "v2", "sentinel.txt");

  try {
    await Promise.all([
      mkdir(join(oldBaseDir, ".lake", "v2"), { recursive: true }),
      mkdir(join(oldBaseDir, ".zcode", "v2"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(lakePayloadPath, "lake-owned"),
      writeFile(zcodeSentinelPath, "zcode-owned"),
    ]);

    await copyDataDirectory(oldBaseDir, newBaseDir);

    assert.equal(
      await readFile(join(newBaseDir, ".lake", "v2", "tasks-index.sqlite"), "utf8"),
      "lake-owned",
    );
    await assert.rejects(readFile(join(newBaseDir, ".zcode", "v2", "sentinel.txt")), {
      code: "ENOENT",
    });
    assert.equal(await readFile(zcodeSentinelPath, "utf8"), "zcode-owned");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("Lake settings never use the ZCode settings directory", () => {
  const settingsFile = getSettingsFilePath();
  assert.ok(settingsFile.endsWith(join(".lake", "v2", "setting.json")));
  assert.ok(!settingsFile.endsWith(join(".zcode", "v2", "setting.json")));
});
