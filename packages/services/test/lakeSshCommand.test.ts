import assert from "node:assert/strict";
import test from "node:test";
import { buildLakeSshArgs } from "../src/terminal/lakeSshCommand.js";

test("SSH target is passed as argv with host-key confirmation, never through a shell command", () => {
  const args = buildLakeSshArgs({
    resourceId: "host-1",
    host: "api.example.test",
    port: 2222,
    username: "ops",
    privateKeyPath: "/tmp/key with spaces",
    updatedAt: 1,
  });
  assert.deepEqual(args, [
    "-tt",
    "-o",
    "StrictHostKeyChecking=ask",
    "-p",
    "2222",
    "-l",
    "ops",
    "-i",
    "/tmp/key with spaces",
    "api.example.test",
  ]);
});
