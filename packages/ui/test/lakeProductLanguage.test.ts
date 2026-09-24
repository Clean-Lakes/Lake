import assert from "node:assert/strict";
import test from "node:test";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import { getBuiltInBeaverMessageIds } from "../src/lib/builtInBeaverPresentation.js";

test("Lake is the user-facing name in both locales", () => {
  for (const messages of [zhCN, enUS]) {
    assert.match(messages["chat.placeholder.newTask"], /Lake/);
    assert.doesNotMatch(messages["chat.placeholder.newTask"], /ZCode/);
    assert.match(messages["settings.subagents.group.builtIn"], /河狸|Beavers/);
    assert.equal(
      Object.values(messages).filter((value) => /ZCode/.test(value)).length,
      0,
      "localized product copy must not retain the old self-name",
    );
  }
});

test("only built-in runtime identities receive Beaver display messages", () => {
  assert.deepEqual(getBuiltInBeaverMessageIds("general-purpose", "built-in", "built-in"), {
    name: "settings.subagents.builtin.generalPurpose.name",
    description: "settings.subagents.builtin.generalPurpose.description",
  });
  assert.deepEqual(getBuiltInBeaverMessageIds("Explore", "built-in", "built-in"), {
    name: "settings.subagents.builtin.explore.name",
    description: "settings.subagents.builtin.explore.description",
  });
  assert.equal(getBuiltInBeaverMessageIds("Explore", "user", "user"), null);
  assert.equal(getBuiltInBeaverMessageIds("general-purpose", "user", "plugin"), null);
  assert.deepEqual(getBuiltInBeaverMessageIds("lake-sre", "built-in", "built-in"), {
    name: "settings.subagents.builtin.sre.name",
    description: "settings.subagents.builtin.sre.description",
  });
  assert.equal(getBuiltInBeaverMessageIds("lake-sre", "user", "user"), null);
  assert.equal(zhCN["settings.subagents.builtin.generalPurpose.name"], "通用河狸");
  assert.equal(zhCN["settings.subagents.builtin.explore.name"], "探索河狸");
  assert.equal(zhCN["settings.subagents.builtin.sre.name"], "SRE 河狸");
  assert.equal(enUS["settings.subagents.builtin.generalPurpose.name"], "General Beaver");
  assert.equal(enUS["settings.subagents.builtin.explore.name"], "Explore Beaver");
  assert.equal(enUS["settings.subagents.builtin.sre.name"], "SRE Beaver");
});

test("all user-facing subagent terminology uses Beaver in both locales", () => {
  assert.equal(zhCN["chat.slash.subagents.title"], "河狸");
  assert.equal(enUS["chat.slash.subagents.title"], "Beavers");
  assert.equal(zhCN["settings.subagents.title"], "河狸");
  assert.equal(enUS["settings.subagents.title"], "Beavers");
  assert.equal(zhCN["settings.subagents.group.plugin"], "插件河狸");
  assert.equal(enUS["settings.subagents.group.plugin"], "Plugin Beavers");
  assert.deepEqual(
    Object.entries(zhCN).filter(([, value]) =>
      /子智能体|子代理/.test(value.replace(/\{[^}]+\}/g, "")),
    ),
    [],
  );
  assert.deepEqual(
    Object.entries(enUS).filter(([, value]) => /sub.?agent/i.test(value.replace(/\{[^}]+\}/g, ""))),
    [],
  );
});
