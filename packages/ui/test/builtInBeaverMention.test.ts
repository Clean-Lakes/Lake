import assert from "node:assert/strict";
import test from "node:test";
import { mapSubagentsToMentionItemsForTest } from "../src/mentions/providers/subagentsMentionProvider.js";

const formatMessage = (id: string) =>
  ({
    "settings.subagents.builtin.generalPurpose.name": "通用河狸",
    "settings.subagents.builtin.generalPurpose.description": "处理多步骤任务",
    "settings.subagents.group.builtIn": "内置河狸",
    "settings.subagents.group.user": "用户河狸",
    "settings.subagents.group.plugin": "插件河狸",
    "settings.subagents.group.workspace": "工作区河狸",
  })[id] ?? id;

test("built-in mention uses Beaver display name but keeps the runtime command value", () => {
  const [item] = mapSubagentsToMentionItemsForTest(
    [
      {
        id: "built-in:general-purpose",
        name: "general-purpose",
        description: "General-purpose agent",
        path: "built-in:general-purpose",
        scope: "built-in",
        source: "built-in",
        enabled: true,
      },
    ],
    formatMessage,
  );
  assert.equal(item?.displayLabel, "通用河狸");
  assert.equal(item?.value, "general-purpose");
  assert.match(item?.markdown ?? "", /general-purpose/);
});

test("user, plugin and workspace agents keep their names but use Beaver source labels", () => {
  const items = mapSubagentsToMentionItemsForTest(
    [
      {
        id: "user:custom",
        name: "custom",
        description: "Custom agent",
        path: "user:custom",
        scope: "user",
        source: "user",
        enabled: true,
      },
      {
        id: "plugin:helper",
        name: "helper",
        description: "Plugin agent",
        path: "plugin:helper",
        scope: "plugin",
        source: "plugin",
        enabled: true,
      },
      {
        id: "workspace:checker",
        name: "checker",
        description: "Workspace agent",
        path: "workspace:checker",
        scope: "workspace",
        source: "user",
        enabled: true,
      },
    ],
    formatMessage,
  );
  assert.deepEqual(
    items.map(({ label, description }) => ({ label, description })),
    [
      { label: "custom", description: "用户河狸 · Custom agent" },
      { label: "helper", description: "插件河狸 · Plugin agent" },
      { label: "checker", description: "工作区河狸 · Workspace agent" },
    ],
  );
});
