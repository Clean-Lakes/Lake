import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCli,
  assertSupported,
  invocationOptions,
  helpText,
} from "../../src/surfaces/cli-options.js";
test("Codex style prompt, subcommand aliases, scoped options and help topics", () => {
  assert.equal(parseCli([]).command, "chat");
  assert.deepEqual(parseCli(["修复", "测试"]).args, ["修复", "测试"]);
  const parsed = parseCli([
    "-C",
    "/tmp",
    "e",
    "-m",
    "ds-flash",
    "-c",
    'model_reasoning_effort="low"',
    "-c",
    "limits.sessionMaxModelCalls=12",
    "--add-dir",
    "../src",
    "--json",
    "--",
    "-prompt",
  ]);
  assert.equal(parsed.command, "exec");
  assert.deepEqual(parsed.args, ["-prompt"]);
  const { invocation } = invocationOptions(parsed.values);
  assert.equal(invocation.model, "ds-flash");
  assert.equal(invocation.reasoningEffort, "low");
  assert.equal(invocation.maxCalls, 12);
  assert.deepEqual(invocation.workspaceRoots, ["/tmp", "/src"]);
  assert.equal(parseCli(["exec", "--help"]).args[0], "exec");
  assert.match(helpText("exec"), /JSONL/);
  assert.equal(parseCli(["-V"]).command, "version");
  assert.equal(parseCli(["exec", "resume", "--last"]).args[0], "resume");
});
test("CLI profile precedence, policy validation and unsupported features are explicit", () => {
  const preferences = {
    defaults: { model: "default", sandbox_mode: "read-only" },
    profiles: { ds: { model: "deepseek-flash", model_provider: "ds-flash" } },
  };
  const p = invocationOptions(
    parseCli(["-p", "ds", "-m", "final", "-a", "never", "--full-auto"]).values,
    preferences,
  );
  assert.equal(p.invocation.model, "final");
  assert.equal(p.providerId, "ds-flash");
  assert.equal(p.invocation.sandboxMode, "workspace-write");
  assert.equal(p.invocation.approvalPolicy, "never");
  assert.throws(() => invocationOptions({ config: ["api_key=value"] }));
  assert.throws(() => invocationOptions({ sandbox: "anything" }));
  assert.throws(() => invocationOptions({ profile: "missing" }, preferences));
  assert.throws(() => parseCli(["--made-up"]));
  assert.throws(() => assertSupported(parseCli(["cloud"])));
  assert.throws(() => assertSupported(parseCli(["--image", "file.png"])));
});
