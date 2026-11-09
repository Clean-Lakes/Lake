import { test } from "node:test";
import assert from "node:assert/strict";
import { finalReportBoundary, finalReportReminder } from "./final-report";

test("the SDK final-report continuation stays in the original turn and excludes new business I/O", async () => {
  let requests = 0;
  const report = finalReportBoundary(() => { requests++; return true; });
  const input = { hookEventName: "Stop", stopHookActive: false } as any;
  assert.equal((await report.hookRunner.run(input)).stopShouldContinue, true);
  assert.equal(requests, 1);
  assert.equal((await report.hookRunner.run({ ...input, stopHookActive: true })).stopShouldContinue, undefined);
  assert.equal(requests, 1, "a stubborn model does not create an unbounded completion loop");
  assert.match(finalReportReminder, /Writing or appending/);
  const original = { tools: [{ name: "Bash" }, { name: "Write" }, { name: "Edit" }, { name: "Agent" }, { name: "work_finish" }, { name: "TaskOutput" }] };
  assert.deepEqual(report.project(original).tools.map(tool => tool.name), ["work_finish", "TaskOutput"]);
  assert.equal(original.tools.length, 6);
  assert.equal(report.allows("Edit"), false);
  assert.equal(report.allows("work_finish"), true);
  await report.hookRunner.run({ hookEventName: "UserPromptSubmit" } as any);
  assert.equal(report.allows("Bash"), true, "a later admitted turn retains normal agent capability");
});

test("cancellation, ordinary conversation and an already submitted report do not request another model step", async () => {
  let checked = false;
  const report = finalReportBoundary(() => { checked = true; return false; });
  const stop = { hookEventName: "Stop", stopHookActive: false } as any;
  const controller = new AbortController(); controller.abort();
  assert.equal((await report.hookRunner.run(stop, { signal: controller.signal })).stopShouldContinue, undefined);
  assert.equal(checked, false);
  assert.equal((await report.hookRunner.run(stop)).stopShouldContinue, undefined);
  assert.equal(report.allows("Write"), true);
  assert.equal((await finalReportBoundary(undefined).hookRunner.run(stop)).stopShouldContinue, undefined);
});
