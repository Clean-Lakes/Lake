import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LAKE_UPDATE_MANIFEST_URL,
  LAKE_UPDATE_POLL_INTERVAL_MS,
  resolveUpdateAssetBaseUrl,
  resolveUpdateManifestRequestUrl,
} from "../src/main/lakeUpdateFeed.js";

test("packaged Lake checks the GitHub latest release manifest every five minutes", () => {
  assert.equal(
    DEFAULT_LAKE_UPDATE_MANIFEST_URL,
    "https://github.com/Clean-Lakes/Lake/releases/latest/download/latest-mac.yml",
  );
  assert.equal(LAKE_UPDATE_POLL_INTERVAL_MS, 5 * 60 * 1000);

  const manifestUrl = resolveUpdateManifestRequestUrl({
    endpointOrigin: "https://update.invalid",
    manifestUrl: DEFAULT_LAKE_UPDATE_MANIFEST_URL,
    platform: "darwin-aarch64",
    deviceMid: "must-not-leak",
    channel: "stable",
  });
  assert.equal(manifestUrl.href, DEFAULT_LAKE_UPDATE_MANIFEST_URL);
  assert.equal(manifestUrl.search, "");
});

test("relative GitHub release assets resolve beside latest-mac.yml", () => {
  const baseUrl = resolveUpdateAssetBaseUrl(new URL(DEFAULT_LAKE_UPDATE_MANIFEST_URL));
  assert.equal(
    new URL("Lake-0.0.2-mac-arm64.zip", baseUrl).href,
    "https://github.com/Clean-Lakes/Lake/releases/latest/download/Lake-0.0.2-mac-arm64.zip",
  );
});

test("service manifest fallback keeps platform, device and channel query parameters", () => {
  const manifestUrl = resolveUpdateManifestRequestUrl({
    endpointOrigin: "https://updates.example.com/base/",
    platform: "darwin-aarch64",
    deviceMid: "device-1",
    channel: "preview",
  });
  assert.equal(manifestUrl.pathname, "/api/v1/releases/electron/manifest");
  assert.equal(manifestUrl.searchParams.get("platform"), "darwin-aarch64");
  assert.equal(manifestUrl.searchParams.get("device_mid"), "device-1");
  assert.equal(manifestUrl.searchParams.get("channel"), "3");
});
