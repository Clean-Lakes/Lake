import test from "node:test";
import assert from "node:assert/strict";
import { validateTransition } from "../../src/domain/state-machines.js";
test("unknown external effects require reconciliation and never blindly replay", () => {
  assert.throws(() => validateTransition("action", "unknown", "queued"));
  assert.throws(() => validateTransition("action", "unknown", "observed"));
  validateTransition("action", "unknown", "observed", { reconciled: true });
  assert.throws(() => validateTransition("action", "dispatched", "cancelled"));
  validateTransition("action", "dispatched", "cancelled", { stopped: true });
});
test("model statements cannot bypass verification", () => {
  for (const kind of ["task", "specialist"] as const)
    assert.throws(() =>
      validateTransition(
        kind,
        kind === "task" ? "active" : "running",
        "succeeded",
      ),
    );
  validateTransition("task", "active", "succeeded", { verified: true });
  assert.throws(() =>
    validateTransition("step", "pending", "succeeded", { verified: true }),
  );
  assert.throws(() => validateTransition("specialist", "succeeded", "running"));
});
