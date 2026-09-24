import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveDesktopProductIdentity,
  resolveWindowsAppUserModelIdForFlavor,
} from "../scripts/desktop-product-identity.mjs";
import {
  DEV_ELECTRON_APP_BUNDLE_ID,
  DEV_ELECTRON_APP_NAME,
  resolveDevElectronAppBundlePath,
} from "../scripts/devElectronAppBundle.mjs";

test("Lake packaged and development application identities do not reuse ZCode identities", () => {
  const production = resolveDesktopProductIdentity({ ZCODE_ENV: "production" });
  const preview = resolveDesktopProductIdentity({ ZCODE_ENV: "test" });
  assert.equal(production.productName, "Lake");
  assert.equal(preview.productName, "Lake Preview");
  assert.notEqual(production.appId, preview.appId);
  assert.notEqual(production.appId, "dev.zcode.app");
  assert.notEqual(preview.appId, "dev.zcode.app.preview");
  assert.equal(DEV_ELECTRON_APP_NAME, "Lake Dev");
  assert.notEqual(DEV_ELECTRON_APP_BUNDLE_ID, "dev.zcode.app.development");
  assert.equal(
    resolveWindowsAppUserModelIdForFlavor("production", { isPackaged: false }),
    "dev.cleanlakes.lake.development",
  );
  assert.ok(
    resolveDevElectronAppBundlePath({
      runtimeRoot: "/tmp/lake",
      electronVersion: "1",
      arch: "arm64",
    }).endsWith("Lake Dev.app"),
  );
});
