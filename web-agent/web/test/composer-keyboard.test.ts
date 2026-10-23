import assert from "node:assert/strict";
import test from "node:test";
import { CompositionGuard, isSendKey, parseSendShortcut } from "../src/composerKeyboard";

test("IME candidate confirmation and navigation bypass sending and mention selection", () => {
  const guard = new CompositionGuard();
  guard.start();
  for (const key of ["Enter", "Tab", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape"]) assert.equal(guard.ignores({key}, 100), true);
  guard.end(100);
  assert.equal(guard.ignores({key: "Enter", isComposing: true}, 200), true);
  assert.equal(guard.ignores({key: "Enter", isComposing: false, keyCode: 229}, 200), true);
});

test("composition ending before its confirming Enter does not submit; later Enter works", () => {
  const guard = new CompositionGuard();
  guard.start();
  guard.end(100);
  const confirm = {key: "Enter", isComposing: false, keyCode: 13};
  assert.equal(guard.ignores(confirm, 101), true);
  assert.equal(guard.ignores(confirm, 151), false);
  assert.equal(isSendKey(confirm, "enter"), true);
});

test("Enter mode sends plain Enter and preserves modified Enter as a newline", () => {
  assert.equal(isSendKey({key: "Enter"}, "enter"), true);
  for (const modifier of ["shiftKey", "metaKey", "ctrlKey", "altKey", "repeat"]) {
    assert.equal(isSendKey({key: "Enter", [modifier]: true}, "enter"), false);
  }
  assert.equal(isSendKey({key: "Tab"}, "enter"), false);
});

test("Command mode sends only Command or Ctrl Enter, with IME and newline safeguards", () => {
  assert.equal(isSendKey({key: "Enter"}, "command-enter"), false);
  for (const modifier of ["metaKey", "ctrlKey"]) {
    const send = {key: "Enter", [modifier]: true};
    assert.equal(isSendKey(send, "command-enter"), true);
    assert.equal(isSendKey({...send, shiftKey: true}, "command-enter"), false);
    assert.equal(isSendKey({...send, altKey: true}, "command-enter"), false);
    assert.equal(isSendKey({...send, isComposing: true}, "command-enter"), false);
    assert.equal(isSendKey({...send, keyCode: 229}, "command-enter"), false);
    assert.equal(isSendKey({...send, repeat: true}, "command-enter"), false);
  }
});

test("saved shortcuts reload safely while absent or invalid preferences keep Enter", () => {
  assert.equal(parseSendShortcut("command-enter"), "command-enter");
  for (const saved of [null, "enter", "unexpected"]) assert.equal(parseSendShortcut(saved), "enter");
});
