import {
  createInterface,
  emitKeypressEvents,
  type Interface,
  type Key,
} from "node:readline";
import { terminalText, statusText } from "./cli-renderer.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const commands = [
  "/status",
  "/model",
  "/new",
  "/resume",
  "/approve",
  "/cancel",
  "/help",
  "/quit",
  "/exit",
];
const chars = (text: string) =>
  [...segmenter.segment(text)].map((s) => s.segment);
function width(char: string): number {
  if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(char)) return 0;
  const c = char.codePointAt(0)!;
  return c >= 0x1100 &&
    (c <= 0x115f ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe10 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      c >= 0x1f000)
    ? 2
    : 1;
}
function clip(text: string, columns: number): string {
  let used = 0,
    out = "";
  for (const c of chars(text)) {
    used += width(c);
    if (used > columns) break;
    out += c;
  }
  return out;
}

/** Scrollback owns committed messages; the bottom area owns the live stream,
 * activity and composer. Redrawing never consumes or overwrites the input. */
export class ConversationTerminal {
  readonly tty = !!(process.stdin.isTTY && process.stderr.isTTY);
  private input?: Interface;
  private buffer: string[] = [];
  private position = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private draft = "";
  private pasted = false;
  private completion: { prefix: string; index: number } | undefined;
  private lines: string[] = [];
  private waiter: ((line: string | undefined) => void) | undefined;
  private closed = false;
  private drawn = false;
  private cursorRow = 0;
  private status = "就绪";
  private live = "";
  private readonly wasRaw = process.stdin.isRaw;
  private readonly keypress = (s: string, key: Key) => this.key(s, key);
  private readonly resize = () => this.render();
  constructor(
    private readonly interrupt: (mode: "interrupt" | "cancel") => void,
    private readonly color = "auto",
  ) {
    if (this.tty) {
      emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("keypress", this.keypress);
      process.stderr.on("resize", this.resize);
      process.stderr.write("\x1b[?2004h");
      this.render();
    } else {
      this.input = createInterface({ input: process.stdin, terminal: false });
      this.input.on("line", (line) => this.enqueue(line));
      this.input.on("close", () => this.close());
    }
  }
  async nextLine(): Promise<string | undefined> {
    if (this.lines.length) return this.lines.shift();
    if (this.closed) return undefined;
    return new Promise((r) => {
      this.waiter = r;
    });
  }
  private enqueue(line: string): void {
    if (this.waiter) {
      const r = this.waiter;
      this.waiter = undefined;
      r(line);
    } else this.lines.push(line);
  }
  activity(text: string): void {
    const safe = terminalText(text);
    if (safe === this.status) return;
    this.status = safe;
    this.render();
  }
  stream(text: string): void {
    const safe = terminalText(text);
    if (!this.tty) process.stdout.write(safe);
    else {
      this.live += safe;
      this.render();
    }
  }
  flush(): void {
    if (!this.live) return;
    const text = this.live;
    this.live = "";
    this.message(text);
  }
  message(text: string, kind: "answer" | "notice" | "user" = "answer"): void {
    this.clear();
    const output = kind === "answer" ? process.stdout : process.stderr;
    output.write(terminalText(text).trimEnd() + "\n\n");
    this.render();
  }
  private clear(): void {
    if (!this.tty || !this.drawn) return;
    process.stderr.write(
      "\r" + (this.cursorRow ? `\x1b[${this.cursorRow}A` : "") + "\x1b[J",
    );
    this.drawn = false;
  }
  private render(): void {
    if (!this.tty || this.closed) return;
    this.clear();
    const columns = Math.max(12, process.stderr.columns || 80),
      available = columns - 4;
    const input = [""];
    let row = 0,
      col = 0,
      cursor = { row: 0, col: 0 };
    for (let i = 0; i <= this.buffer.length; i++) {
      if (i === this.position) cursor = { row, col };
      if (i === this.buffer.length) break;
      const c = this.buffer[i]!;
      if (c === "\n") {
        input.push("");
        row++;
        col = 0;
        continue;
      }
      if (col + width(c) > available) {
        input.push("");
        row++;
        col = 0;
        if (i === this.position) cursor = { row, col };
      }
      input[row] = input[row]! + c;
      col += width(c);
    }
    const maxRows = Math.max(1, Math.min(6, (process.stderr.rows || 24) - 7));
    const first = Math.max(0, cursor.row - maxRows + 1);
    const view = input
      .slice(first, first + maxRows)
      .map((line, i) => (i === 0 ? "› " : "  ") + line);
    const live = this.live
      .split("\n")
      .flatMap((line) => {
        const rows = [""];
        let n = 0;
        for (const c of chars(line)) {
          if (n + width(c) > columns - 1) {
            rows.push("");
            n = 0;
          }
          rows[rows.length - 1] += c;
          n += width(c);
        }
        return rows;
      })
      .slice(
        -Math.max(
          1,
          Math.min(8, (process.stderr.rows || 24) - view.length - 5),
        ),
      );
    const prefix = this.live ? live : [];
    const footer = [
      ...prefix,
      statusText(
        clip("• " + this.status, columns - 1),
        this.status.includes("已完成")
          ? "succeeded"
          : this.status.includes("失败")
            ? "failed"
            : "active",
        this.color,
      ),
      "─".repeat(columns - 1),
      ...view,
      clip(
        this.buffer[0] === "/" && !this.buffer.includes(" ")
          ? commands
              .filter((c) => c.startsWith(this.buffer.join("")))
              .join(" · ") + " · Tab 补全"
          : "Enter 发送 · Alt+Enter 换行 · ↑ 历史 · Esc 取消 · /help",
        columns - 1,
      ),
    ];
    const targetRow = prefix.length + 2 + cursor.row - first;
    process.stderr.write(
      footer.join("\r\n") +
        "\r" +
        `\x1b[${footer.length - 1 - targetRow}A` +
        `\x1b[${cursor.col + 2}C`,
    );
    this.cursorRow = targetRow;
    this.drawn = true;
  }
  private key(text: string, key: Key = {}): void {
    if (key.name !== "tab") this.completion = undefined;
    if (key.sequence === "\x1b[200~") {
      this.pasted = true;
      return;
    }
    if (key.sequence === "\x1b[201~") {
      this.pasted = false;
      this.render();
      return;
    }
    if (this.pasted) {
      if (text) this.insert(text.replace(/\r\n?/g, "\n"));
      return;
    }
    if (key.name === "tab" && this.buffer[0] === "/") {
      const prefix = this.completion?.prefix ?? this.buffer.join("");
      const matches = commands.filter((c) => c.startsWith(prefix));
      if (matches.length) {
        const index = this.completion
          ? (this.completion.index + 1) % matches.length
          : 0;
        this.completion = { prefix, index };
        this.buffer = chars(matches[index]!);
        this.position = this.buffer.length;
        this.render();
      }
    } else if (key.ctrl && key.name === "c") {
      if (this.buffer.length) {
        this.buffer = [];
        this.position = 0;
        this.render();
      } else this.interrupt("interrupt");
    } else if (key.ctrl && key.name === "z")
      process.kill(process.pid, "SIGTSTP");
    else if (key.name === "escape") this.interrupt("cancel");
    else if (key.ctrl && key.name === "d" && !this.buffer.length) this.close();
    else if (key.name === "return" && !key.meta && !key.shift) {
      const line = this.buffer.join("").trim();
      this.buffer = [];
      this.position = 0;
      if (line) {
        this.history.push(line);
        this.historyIndex = this.history.length;
        this.draft = "";
        this.message("› " + line, "user");
        this.enqueue(line);
      } else this.render();
    } else if (key.name === "return" || key.sequence === "\x1b[13;2u")
      this.insert("\n");
    else if (key.name === "left") {
      this.position = Math.max(0, this.position - 1);
      this.render();
    } else if (key.name === "right") {
      this.position = Math.min(this.buffer.length, this.position + 1);
      this.render();
    } else if (key.name === "home" || (key.ctrl && key.name === "a")) {
      this.position = 0;
      this.render();
    } else if (key.name === "end" || (key.ctrl && key.name === "e")) {
      this.position = this.buffer.length;
      this.render();
    } else if (key.ctrl && key.name === "u") {
      this.buffer.splice(0, this.position);
      this.position = 0;
      this.render();
    } else if (key.name === "backspace") {
      if (this.position) this.buffer.splice(--this.position, 1);
      this.render();
    } else if (key.name === "delete") {
      this.buffer.splice(this.position, 1);
      this.render();
    } else if (key.name === "up" || key.name === "down") {
      if (this.historyIndex === this.history.length)
        this.draft = this.buffer.join("");
      this.historyIndex = Math.max(
        0,
        Math.min(
          this.history.length,
          this.historyIndex + (key.name === "up" ? -1 : 1),
        ),
      );
      this.buffer = chars(this.history[this.historyIndex] ?? this.draft);
      this.position = this.buffer.length;
      this.render();
    } else if (
      text &&
      !key.ctrl &&
      !key.meta &&
      !key.sequence?.startsWith("\x1b")
    )
      this.insert(text);
  }
  private insert(text: string): void {
    const safe = terminalText(text).replace(/\t/g, "  ");
    if (Buffer.byteLength(this.buffer.join("") + safe) > 65536) return;
    const added = chars(safe);
    this.buffer.splice(this.position, 0, ...added);
    this.position += added.length;
    this.render();
  }
  suspend(): void {
    this.flush();
    this.clear();
    if (this.tty) {
      process.stderr.write("\x1b[?2004l");
      process.stdin.setRawMode(this.wasRaw || false);
    }
  }
  resume(): void {
    if (this.tty && !this.closed) {
      process.stdin.setRawMode(true);
      process.stderr.write("\x1b[?2004h");
      this.render();
    }
  }
  close(): void {
    if (this.closed) return;
    this.flush();
    this.clear();
    this.closed = true;
    if (this.tty) {
      process.stderr.write("\x1b[?2004l");
      process.stdin.setRawMode(this.wasRaw || false);
      process.stdin.off("keypress", this.keypress);
      process.stderr.off("resize", this.resize);
      process.stdin.pause();
    } else this.input?.close();
    this.waiter?.(undefined);
    this.waiter = undefined;
  }
}
