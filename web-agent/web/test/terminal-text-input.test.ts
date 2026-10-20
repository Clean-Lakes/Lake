import assert from "node:assert/strict";
import test from "node:test";
import {TerminalTextInput, usesWebKitTextInput} from "../src/terminalTextInput";
const committed = (data: string, inputType = "insertText", isComposing = false) => ({data, inputType, isComposing});
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test("English full stop from a WebKit text commit reaches input exactly once", async () => {
  const sent: string[] = [], input = new TerminalTextInput(text => sent.push(text));
  input.keydown(); input.input(committed(".")); input.keyup();
  await tick();
  assert.deepEqual(sent, ["."]);
  input.keydown(); input.data("."); input.input(committed(".")); input.keyup();
  await tick();
  assert.deepEqual(sent, [".", "."]); input.dispose();
});
test("Mac WebKit committed punctuation reaches the PTY without a keypress", async () => {
  const sent: string[] = [], input = new TerminalTextInput(text => sent.push(text));
  for (const text of ["，", "。", "；", "：", "！", "？", "（", "）", " ", "|", "\\", "'"]) {
    input.keydown(); input.input(committed(text)); input.keyup();
  }
  await tick();
  assert.equal(sent.join(""), "，。；：！？（） |\\'");
  input.dispose();
});
test("normal key data and delayed xterm IME-key fallback are sent exactly once", async () => {
  const sent: string[] = [], input = new TerminalTextInput(text => sent.push(text));
  input.keydown(); input.data("!"); input.input(committed("!")); input.keyup();
  input.keydown(); input.input(committed("，")); input.data("，"); input.keyup();
  input.keydown(); input.data("/"); input.input(committed("/")); input.keyup();
  await tick();
  assert.deepEqual(sent, ["!", "，", "/"]); input.dispose();
});
test("composition, emoji commit and paste remain owned by xterm", async () => {
  const sent: string[] = [], input = new TerminalTextInput(text => sent.push(text));
  input.compositionStart(); input.input(committed("，", "insertCompositionText", true));
  input.compositionEnd(); input.input(committed("😀")); input.data("😀");
  await tick();
  input.keydown(); input.data("pasted，text"); input.input(committed("pasted，text", "insertFromPaste"));
  input.input(committed("中", "insertText", true));
  await tick(); assert.deepEqual(sent, ["😀", "pasted，text"]); input.dispose();
});
test("missing-key input preserves order before Enter and is cancelled on disposal", async () => {
  const sent: string[] = [], input = new TerminalTextInput(text => sent.push(text));
  input.input(committed("，")); input.keydown(); input.data("\r");
  input.input(committed("。")); input.dispose();
  await tick(); assert.deepEqual(sent, ["，", "\r"]);
});
test("compatibility path is scoped to Mac WebKit", () => {
  assert.equal(usesWebKitTextInput("MacIntel", "AppleWebKit/605.1.15 Version/26 Safari"), true);
  assert.equal(usesWebKitTextInput("MacIntel", "AppleWebKit/537.36 Chrome/140 Safari"), false);
  assert.equal(usesWebKitTextInput("Win32", "AppleWebKit/537.36 Edg/140"), false);
});
