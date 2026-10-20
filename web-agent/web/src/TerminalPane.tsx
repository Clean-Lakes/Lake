import { useEffect, useRef, useState, type RefObject } from "react";
import { NavigationMenu } from "./NavigationDelete";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalEntry } from "../../shared/contracts";
import { terminalOutputUpdate } from "./terminalOutput";
import { TerminalTextInput, usesWebKitTextInput } from "./terminalTextInput";

function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(`--terminal-${name}`).trim();
  return {
    background: token("background"), foreground: token("foreground"),
    cursor: token("foreground"), cursorAccent: token("background"), selectionBackground: token("selection"),
    black: token("black"), brightBlack: token("bright-black"), red: token("red"), green: token("green"),
    yellow: token("yellow"), blue: token("blue"), magenta: token("magenta"), cyan: token("cyan"),
    white: token("bright-black"), brightWhite: token("foreground"),
  };
}

export type TerminalHandle = { focus: () => void; clear: () => void };
type Props = { active?: boolean; entries: TerminalEntry[]; output: string; interactive: boolean; showCommandEntries?: boolean; onInput: (data: string) => void; onResize: (cols: number, rows: number) => void; controlRef?: RefObject<TerminalHandle | null> };

/** Real PTY input and output, including the shell's own prompt and line editor. */
export function TerminalPane({ active = true, entries, output, interactive, showCommandEntries = true, onInput, onResize, controlRef }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const propsRef = useRef({ active, interactive, onInput, onResize });
  propsRef.current = { active, interactive, onInput, onResize };
  const previousOutput = useRef("");
  const [menu, setMenu] = useState<{x: number; y: number} | null>(null);
  const [clipboardError, setClipboardError] = useState("");
  useEffect(() => { if (!active) { setMenu(null); setClipboardError(""); } }, [active]);
  async function clipboard(action: "copy" | "paste") {
    try {
      const terminal = terminalRef.current;
      if (!terminal) return;
      if (action === "copy") await navigator.clipboard.writeText(terminal.getSelection());
      else {
        const text = await navigator.clipboard.readText();
        if (propsRef.current.active && propsRef.current.interactive) terminal.paste(text);
      }
      setClipboardError("");
      if (propsRef.current.active) terminal.focus();
    } catch { setClipboardError("无法访问剪贴板，请使用键盘快捷键复制或粘贴。"); }
  }

  useEffect(() => {
    if (!hostRef.current) return;
    let closed = false;
    const terminal = new Terminal({
      allowTransparency: false,
      convertEol: true,
      cursorBlink: true,
      screenReaderMode: true,
      disableStdin: false,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    fitRef.current = fit;
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    const themeObserver = new MutationObserver(() => { terminal.options.theme = terminalTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const sendInput = (data: string) => { if (propsRef.current.active && propsRef.current.interactive) propsRef.current.onInput(data); };
    const textInput = usesWebKitTextInput(navigator.platform, navigator.userAgent) ? new TerminalTextInput(sendInput) : undefined;
    const inputListener = terminal.onData(data => textInput ? textInput.data(data) : sendInput(data));
    const host = hostRef.current;
    const keydown = () => textInput?.keydown();
    const keyup = () => textInput?.keyup();
    const compositionStart = () => textInput?.compositionStart();
    const compositionEnd = () => textInput?.compositionEnd();
    const committedInput = (event: Event) => textInput?.input(event as InputEvent);
    host.addEventListener("keydown", keydown, true);
    host.addEventListener("keyup", keyup, true);
    host.addEventListener("compositionstart", compositionStart, true);
    host.addEventListener("compositionend", compositionEnd);
    host.addEventListener("input", committedInput);
    const sizeListener = terminal.onResize(({ cols, rows }) => { if (propsRef.current.active) propsRef.current.onResize(cols, rows); });
    let resizeFrame = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resize = () => {
      if (closed || resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        if (closed || !propsRef.current.active || !hostRef.current?.isConnected || !hostRef.current.clientWidth || !hostRef.current.clientHeight) return;
        try { fit.fit(); } catch { /* The pane can become hidden during navigation. */ }
      });
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 100);
    });
    observer.observe(hostRef.current);
    // Size the emulator before parsing the initial history.
    if (propsRef.current.active) { try { fit.fit(); } catch {} }
    resize();
    return () => {
      closed = true;
      observer.disconnect();
      themeObserver.disconnect();
      clearTimeout(resizeTimer);
      inputListener.dispose();
      host.removeEventListener("keydown", keydown, true);
      host.removeEventListener("keyup", keyup, true);
      host.removeEventListener("compositionstart", compositionStart, true);
      host.removeEventListener("compositionend", compositionEnd);
      host.removeEventListener("input", committedInput);
      textInput?.dispose();
      sizeListener.dispose();
      previousOutput.current = "";
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      terminalRef.current = null;
      fitRef.current = null;

      // xterm schedules viewport work on open/reset and parses write() asynchronously.
      // Let its queued work drain before disposal, including React StrictMode remounts.
      terminal.write("", () => setTimeout(() => terminal.dispose(), 50));
    };
  }, []);
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = !interactive;
    terminal.options.cursorBlink = interactive;
    if (!active) return;
    if (hostRef.current?.clientWidth && hostRef.current.clientHeight) { try { fitRef.current?.fit(); } catch {} }
    const handle = { focus: () => terminal.focus(), clear: () => terminal.clear() };
    if (controlRef) controlRef.current = handle;
    propsRef.current.onResize(terminal.cols, terminal.rows);
    if (interactive) terminal.focus();
    return () => { if (controlRef?.current === handle) controlRef.current = null; };
  }, [active, interactive, controlRef]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const display = output || (showCommandEntries ? entries.map(entry => `${entry.actor} > ${entry.command}\r\n${entry.output}\r\n`).join("") : "");
    const previous = previousOutput.current;
    if (display === previous) return;
    const update = terminalOutputUpdate(previous, display).text;
    previousOutput.current = display;
    if (!update) return;
    const following = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY - 1;
    terminal.write(update, () => { if (terminalRef.current === terminal && following) terminal.scrollToBottom(); });
  }, [entries, output, showCommandEntries]);

  return <>
    <div className="terminal-screen" ref={hostRef} aria-label={interactive ? "交互终端：可输入按键" : "持续终端输出"} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setClipboardError(""); setMenu({x: event.clientX, y: event.clientY}); }}/>
    {clipboardError && active && <div className="terminal-clipboard-error" role="alert" onClick={() => setClipboardError("")}>{clipboardError}</div>}
    {menu && active && <NavigationMenu title="终端" x={menu.x} y={menu.y} onClose={() => setMenu(null)} actions={[
      {label: "复制", disabled: !terminalRef.current?.hasSelection(), run: () => { void clipboard("copy"); }},
      {label: "粘贴", disabled: !interactive, run: () => { void clipboard("paste"); }},
      {label: "全选", run: () => terminalRef.current?.selectAll()},
      {label: "清屏", run: () => { terminalRef.current?.clear(); terminalRef.current?.focus(); }},
    ]}/>}
  </>;
}
