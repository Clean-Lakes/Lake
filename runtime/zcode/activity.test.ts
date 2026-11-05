import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveToolActivity, toolActivityLabel } from "./activity";

test("live execution tracks parallel calls independently and clears at turn boundaries", () => {
  const activity = new LiveToolActivity();
  assert.equal(activity.latest("worker"), undefined);
  activity.start("worker", "first", "inspect_host", "2026-11-05T10:00:00Z");
  activity.start("worker", "second", "list_assets", "2026-11-05T10:00:01Z");
  activity.start("other", "first", "Read", "2026-11-05T10:00:02Z");
  assert.equal(activity.latest("worker")?.toolName, "list_assets");
  activity.finish("worker", "second");
  assert.equal(activity.latest("worker")?.toolName, "inspect_host");
  activity.finish("worker", "never-started");
  assert.equal(activity.latest("worker")?.toolName, "inspect_host");
  activity.clear("worker");
  assert.equal(activity.latest("worker"), undefined);
  assert.equal(activity.latest("other")?.toolName, "Read");
  activity.finish("other", "first");
  assert.equal(activity.latest("other"), undefined);
});

test("activity descriptions use safe business labels without repeating arbitrary tool names", () => {
  assert.equal(toolActivityLabel("inspect_host"), "正在读取服务器指标");
  assert.equal(toolActivityLabel("list_assets"), "正在查找资源");
  assert.equal(toolActivityLabel("unknown-private-credential-path"), "正在处理任务");
});
