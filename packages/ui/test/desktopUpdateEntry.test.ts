import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveUpdateStatusViewModel,
  resolveUpdateStatusEntryVisualState,
} from "../src/updateStatusModel.js";
import { resolveUpdateStatusEntryPlacement } from "../src/updateStatusEntryPlacement.js";

test("desktop update entry maps updater states to one icon-sized visual state", () => {
  const available = deriveUpdateStatusViewModel({
    legacyReadyVersion: null,
    updateState: { kind: "update-available", enabled: true, version: "3.15.0" },
  });
  assert.equal(resolveUpdateStatusEntryVisualState(available), "available");

  const downloading = deriveUpdateStatusViewModel({
    legacyReadyVersion: null,
    updateState: {
      kind: "download-progress",
      enabled: false,
      progress: "42",
      version: "3.15.0",
    },
  });
  assert.equal(resolveUpdateStatusEntryVisualState(downloading), "downloading");

  const downloaded = deriveUpdateStatusViewModel({
    legacyReadyVersion: null,
    updateState: { kind: "update-downloaded", enabled: true, version: "3.15.0" },
  });
  assert.equal(resolveUpdateStatusEntryVisualState(downloaded), "downloaded");

  const hidden = deriveUpdateStatusViewModel({
    legacyReadyVersion: null,
    updateState: { kind: "idle", enabled: true },
  });
  assert.equal(resolveUpdateStatusEntryVisualState(hidden), null);
});

test("desktop update entry uses header actions and keeps an overlay fallback", () => {
  assert.equal(resolveUpdateStatusEntryPlacement(true), "workspace-header-actions");
  assert.equal(resolveUpdateStatusEntryPlacement(false), "top-overlay-fallback");
});
