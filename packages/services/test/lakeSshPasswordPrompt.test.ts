import assert from "node:assert/strict";
import test from "node:test";
import { createLakeSshPasswordPromptResponder } from "../src/terminal/lakeSshPasswordPrompt.js";

test("saved password is sent only after a standard prompt and only once", () => {
  const writes: string[] = [];
  const responder = createLakeSshPasswordPromptResponder(
    "secret",
    { username: "ops", host: "host" },
    (data) => writes.push(data),
  );

  responder.onData("The authenticity of host can't be established.\r\nAre you sure? ");
  assert.deepEqual(writes, []);
  responder.onData("\r\nops@host's pass");
  assert.deepEqual(writes, []);
  responder.onData("word: ");
  assert.deepEqual(writes, ["secret\r"]);
  responder.onData("Permission denied, please try again.\r\nPassword: ");
  assert.deepEqual(writes, ["secret\r"]);
  responder.dispose();
});

test("non-password keyboard-interactive prompt is left for manual input", () => {
  const writes: string[] = [];
  const responder = createLakeSshPasswordPromptResponder(
    "secret",
    { username: "ops", host: "host" },
    (data) => writes.push(data),
  );
  responder.onData("Verification code: ");
  assert.deepEqual(writes, []);
  responder.dispose();
});

test("generic or mismatched password text does not receive the stored secret", () => {
  const writes: string[] = [];
  const responder = createLakeSshPasswordPromptResponder(
    "secret",
    { username: "ops", host: "host" },
    (data) => writes.push(data),
  );
  responder.onData("Password: ");
  responder.onData("other@host's password: ");
  responder.onData("ops@other-host's password: ");
  assert.deepEqual(writes, []);
  responder.dispose();
});
