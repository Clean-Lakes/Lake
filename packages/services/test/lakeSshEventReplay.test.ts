import assert from "node:assert/strict";
import test from "node:test";
import { createLakeSshEventReplay } from "../src/terminal/lakeSshEventReplay.js";

test("Lake SSH replays output and exit that happened before renderer subscriptions", () => {
  const events = createLakeSshEventReplay();
  events.emitData("ssh: connection refused\r\n");
  events.emitExit(255);

  const output: string[] = [];
  const exitCodes: number[] = [];
  const dataSubscription = events.onData((data) => output.push(data));
  const exitSubscription = events.onExit((code) => exitCodes.push(code));

  assert.deepEqual(output, ["ssh: connection refused\r\n"]);
  assert.deepEqual(exitCodes, [255]);
  dataSubscription.dispose();
  exitSubscription.dispose();
  events.dispose();
});

test("Lake SSH buffers only until first data subscriber and drops events after disposal", () => {
  const events = createLakeSshEventReplay();
  events.emitData("early");
  const first: string[] = [];
  const firstSubscription = events.onData((data) => first.push(data));
  events.emitData("live");
  const second: string[] = [];
  const secondSubscription = events.onData((data) => second.push(data));

  assert.deepEqual(first, ["early", "live"]);
  assert.deepEqual(second, []);
  events.dispose();
  events.emitData("ignored");
  events.emitExit(0);
  assert.deepEqual(first, ["early", "live"]);
  firstSubscription.dispose();
  secondSubscription.dispose();
});
