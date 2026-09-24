import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveCliTelemetryStateFile } from "../device/cli-device-mid.js";
import { resolveSharedZCodeCredentialsPath } from "./shared-credentials.js";

test("embedded Agent credentials and device identity prefer the Lake storage root", () => {
  const lakeRoot = resolve("tmp", "lake-home", ".lake");
  const env = {
    ZCODE_DATA_BASE_DIR: join("tmp", "must-not-be-used"),
    ZCODE_STORAGE_DIR: lakeRoot,
  };

  assert.equal(
    resolveSharedZCodeCredentialsPath({ env }),
    join(lakeRoot, "v2", "credentials.json"),
  );
  assert.equal(
    resolveCliTelemetryStateFile({ env }),
    join(lakeRoot, "v2", "telemetry-state.json"),
  );
});
