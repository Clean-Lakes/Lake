import assert from "node:assert/strict";
import test from "node:test";
import { resolveZCodeBuiltinPromptCommand } from "./builtin-prompt-command.js";

test("built-in init prompt uses Lake language but preserves compatibility paths", () => {
  const prompt = resolveZCodeBuiltinPromptCommand("/init", {
    workingDirectory: "/workspace/example",
  });
  assert.ok(prompt);
  assert.match(prompt, /Lake's built-in \/init/);
  assert.match(prompt, /future Lake agents/);
  assert.doesNotMatch(prompt, /future ZCode agents|ZCode's built-in/);
  assert.match(prompt, /\.zcode\/AGENTS\.md/);
});
