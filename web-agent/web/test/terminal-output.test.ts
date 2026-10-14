import assert from "node:assert/strict";
import test from "node:test";
import { terminalOutputUpdate } from "../src/terminalOutput";

test("ordinary PTY output appends without clearing the terminal", () => {
  assert.deepEqual(terminalOutputUpdate("prompt ", "prompt ls\r\n"), { text: "ls\r\n", reset: false });
});

test("a bounded history sliding on every keystroke appends only the new bytes", () => {
  const previous = "x".repeat(16000) + "prompt ";
  const next = previous.slice(4) + "test";
  assert.deepEqual(terminalOutputUpdate(previous, next), { text: "test", reset: false });
});

test("a changed or redacted history requires a fresh terminal replay", () => {
  const previous = "prompt secret";
  assert.deepEqual(terminalOutputUpdate(previous, "prompt [REDACTED]"), {
    text: "\x1b[2J\x1b[3J\x1b[Hprompt [REDACTED]", reset: true,
  });
});
