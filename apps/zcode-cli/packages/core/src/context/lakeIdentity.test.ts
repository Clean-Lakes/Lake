import assert from "node:assert/strict";
import test from "node:test";
import { readToolEntry } from "../tool/handlers/read.js";
import { ContextBuilder } from "./builder.js";

const baseConfig = {
  workingDirectory: "/workspace/example",
  envInfo: {
    cwd: "/workspace/example",
    platform: "darwin",
    shell: "zsh",
    osVersion: "test",
    nodeVersion: "24",
  },
} as const;

function systemText(result: ReturnType<ContextBuilder["build"]>): string {
  return result.systemMessages.map((message) => message.content).join("\n");
}

test("default desktop and terminal sessions identify the main agent as Lake", () => {
  for (const presentationSurface of ["terminal", "zcode_desktop"] as const) {
    const result = new ContextBuilder({ ...baseConfig, presentationSurface }).build();
    const prompt = systemText(result);
    assert.match(prompt, /You are Lake/);
    assert.match(prompt, /Clean-Lakes/);
    assert.match(prompt, /software operations|SRE/);
    assert.match(prompt, /project.*lake|lake.*project/i);
    assert.match(prompt, /registration does not imply.*monitoring/i);
    assert.match(prompt, /reversible.*traceable/i);
    assert.match(prompt, /When asked who you are/);
    assert.match(prompt, /你好，我是 Lake，由 Clean-Lakes 打造/);
    assert.match(prompt, /ordinary greeting|greeted/i);
    assert.doesNotMatch(prompt, /You are ZCode|interactive ZCode agent/);
    assert.ok(result.sections.some((section) => section.source === "identity"));
    if (presentationSurface === "zcode_desktop") {
      assert.match(prompt, /# Lake Desktop Context/);
    }
  }
});

test("output style keeps Lake identity; explicit custom prompt only keeps product framing", () => {
  const styled = new ContextBuilder({
    ...baseConfig,
    outputStyle: { name: "Concise", prompt: "Use short answers." },
  }).build();
  assert.match(systemText(styled), /You are Lake/);
  assert.match(systemText(styled), /Clean-Lakes/);

  const custom = new ContextBuilder({
    ...baseConfig,
    customSystemPrompt: "You are a specialist for this one task.",
  }).build();
  assert.match(systemText(custom), /Lake/);
  assert.doesNotMatch(systemText(custom), /You are Lake/);
  assert.ok(custom.sections.some((section) => section.source === "custom_system_prompt"));
  assert.ok(!custom.sections.some((section) => section.source === "identity"));
});

test("workflow actor keeps its independent script-facing role", () => {
  const result = new ContextBuilder({ ...baseConfig, workflowActor: { name: "reviewer" } }).build();
  assert.ok(!result.sections.some((section) => section.source === "cli_prefix"));
  assert.ok(!result.sections.some((section) => section.source === "identity"));
  assert.match(systemText(result), /A script created you/);
});

test("Read tool description does not reintroduce the old product name", () => {
  assert.doesNotMatch(readToolEntry.metadata.description, /ZCode/);
});
