import assert from "node:assert/strict";
import test from "node:test";
import { SECONDARY_WORKSPACE_SIDEBAR_ENTRIES_VISIBLE } from "../src/lib/sidebarEntryVisibility.js";

test("secondary workspace sidebar entries remain hidden during Lake resource MVP", () => {
  assert.equal(SECONDARY_WORKSPACE_SIDEBAR_ENTRIES_VISIBLE, false);
});
