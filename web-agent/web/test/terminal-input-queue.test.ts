import assert from "node:assert/strict";
import test from "node:test";
import { TerminalInputQueue } from "../src/terminalInputQueue";

test("keystrokes arriving during a request are combined in order for the same terminal", async () => {
  const sent: string[] = [];
  let release: (() => void) | undefined;
  const first = new Promise<void>(resolve => { release = resolve; });
  const queue = new TerminalInputQueue(async (_session, _terminal, data) => {
    sent.push(data);
    if (sent.length === 1) await first;
  }, error => { throw error; });
  queue.enqueue("session", "term", "a\r");
  queue.enqueue("session", "term", "b");
  queue.enqueue("session", "term", "c");
  assert.deepEqual(sent, ["a\r"]);
  release!();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, ["a\r", "bc"]);
});

test("input from different terminals stays separate and a large paste respects the server byte limit", async () => {
  const sent: { terminal: string; data: string }[] = [];
  const queue = new TerminalInputQueue(async (_session, terminal, data) => { sent.push({ terminal, data }); }, error => { throw error; });
  queue.enqueue("session", "first", "中".repeat(1400));
  queue.enqueue("session", "second", "pwd\r");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent.map(item => item.terminal), ["first", "first", "second"]);
  assert.ok(sent.every(item => new TextEncoder().encode(item.data).length <= 4096));
  assert.equal(sent.filter(item => item.terminal === "first").map(item => item.data).join(""), "中".repeat(1400));
});
