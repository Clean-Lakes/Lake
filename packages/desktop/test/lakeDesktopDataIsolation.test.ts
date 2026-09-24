import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { resolveChromiumHardwareAccelerationSettingsFile } from "../src/main/desktopChromiumHardwareAccelerationBootstrap.js";
import { resolveBootstrapSettingsFile } from "../src/main/desktopDataBaseDirBootstrap.js";
import {
  LAKE_CLI_LOG_ARCHIVE_PREFIX,
  LAKE_CUA_RUN_ARCHIVE_PREFIX,
  resolveLakeCliDir,
  resolveLakeCuaHelperRunDir,
} from "../src/main/lakeDiagnosticPaths.js";

test("early desktop bootstrap reads Lake settings instead of ZCode settings", () => {
  const homePath = join("tmp", "lake-home");
  const settingsFile = resolveChromiumHardwareAccelerationSettingsFile(homePath);
  assert.equal(settingsFile, join(homePath, ".lake", "v2", "setting.json"));
  assert.ok(!settingsFile.includes(`${join(".zcode", "v2")}`));
  assert.equal(
    resolveBootstrapSettingsFile(homePath),
    join(homePath, ".lake", "v2", "setting.json"),
  );
});

test("diagnostic collection stays under the Lake data root", () => {
  const dataRoot = join("tmp", "lake-home", ".lake");
  assert.equal(resolveLakeCliDir(dataRoot), join(dataRoot, "cli"));
  assert.equal(resolveLakeCuaHelperRunDir(dataRoot), join(dataRoot, "computer-use", "run"));
  assert.equal(LAKE_CLI_LOG_ARCHIVE_PREFIX, ".lake/cli/log");
  assert.equal(LAKE_CUA_RUN_ARCHIVE_PREFIX, ".lake/computer-use/run");
});
