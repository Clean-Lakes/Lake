import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { resolveCliProviderEnvironmentConfigRoot } from "./provider-runtime-env.js";

test("embedded Agent provider config prefers the Lake storage root", () => {
  const lakeRoot = join("tmp", "lake-home", ".lake");
  assert.equal(
    resolveCliProviderEnvironmentConfigRoot({
      env: {
        ZCODE_DATA_BASE_DIR: join("tmp", "must-not-be-used"),
        ZCODE_STORAGE_DIR: lakeRoot,
      },
    }),
    join(lakeRoot, "v2"),
  );
});
