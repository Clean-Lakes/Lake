import { useEffect, useRef, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalEntry } from "../../shared/contracts";

export type TerminalHandle = { focus: () => void; clear: () => void };
type Props = { entries: TerminalEntry[]; output: string; interactive: boolean; showCommandEntries?: boolean; onInput: (data: string) => void; onResize: (cols: number, rows: number) => void; controlRef?: RefObject<TerminalHandle | null> };

/** Real PTY input and output, including the shell's own prompt and line editor. */
export function TerminalPane({ entries, output, interactive, showCommandEntries = true, onInput, onResize, controlRef }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const propsRef = useRef({ interactive, onInput, onResize });
  propsRef.current = { interactive, onInput, onResize };
  const previousOutput = useRef("");

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
      theme: {
        background: "#eef0f5",
        foreground: "#424955",
        cursor: "#646b75",
        cursorAccent: "#eef0f5",
        selectionBackground: "#ccd2df",
        black: "#424955", brightBlack: "#707781",
        blue: "#5274a5", cyan: "#458e98", green: "#48866d",
        red: "#b45c69", magenta: "#aa597d", yellow: "#a58544",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    if (controlRef) controlRef.current = { focus: () => terminal.focus(), clear: () => terminal.clear() };
    const inputListener = terminal.onData(data => { if (propsRef.current.interactive) propsRef.current.onInput(data); });
    const sizeListener = terminal.onResize(({ cols, rows }) => propsRef.current.onResize(cols, rows));
    let resizeFrame = 0;
    const resize = () => {
      if (closed || resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        if (closed || !hostRef.current?.isConnected) return;
        try { fit.fit(); } catch { /* The pane can become hidden during navigation. */ }
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(hostRef.current);
    resize();
    return () => {
      closed = true;
      observer.disconnect();
      inputListener.dispose();
      sizeListener.dispose();
      previousOutput.current = "";
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      terminalRef.current = null;
      if (controlRef) controlRef.current = null;
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
    if (interactive) terminal.focus();
  }, [interactive]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const display = output || (showCommandEntries ? entries.map(entry => `${entry.actor} > ${entry.command}\r\n${entry.output}\r\n`).join("") : "");
    const previous = previousOutput.current;
    if (display === previous) return;
    const update = display.startsWith(previous) ? display.slice(previous.length) : `\x1b[2J\x1b[3J\x1b[H${display}`;
    previousOutput.current = display;
    terminal.write(update, () => { if (terminalRef.current === terminal) terminal.scrollToBottom(); });
  }, [entries, output, showCommandEntries]);

  return <div className="terminal-screen" ref={hostRef} aria-label={interactive ? "交互终端：可输入按键" : "持续终端输出"} />;
}
