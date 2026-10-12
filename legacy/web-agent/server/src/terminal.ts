import xterm from "@xterm/headless";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { spawn, type IPty, type IPtyForkOptions } from "node-pty";
import type { TerminalEntry, TerminalSession } from "../../shared/contracts.js";
import { activeSecrets } from "./model-config.js";
import { sshArguments, sshConfig } from "./ssh.js";
import { ApiFailure, Store } from "./store.js";
import { commandPolicy } from "../../shared/command-policy.js";

const OUTPUT_BYTES = 32768;
const CONNECT_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 120000;
const FLUSH_MS = 100;
const MAX_LIVE_TERMINALS = 16;
const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;

function redact(value: string): string {
  let safe = value.replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, "[PRIVATE KEY REDACTED]");
  for (const secret of [process.env.LAKE_WEB_MODEL_KEY, process.env.LAKE_WEB_TOKEN, ...activeSecrets()]) {
    if (!secret || secret.length <= 3) continue;
    safe = safe.split(secret).join("[REDACTED]");
      for (let size = Math.min(secret.length - 1, safe.length); size >= 1; size--) {
        if (safe.endsWith(secret.slice(0, size))) { safe = safe.slice(0, -size) + "[REDACTED]"; break; }
      }
  }
  return safe;
}
const tail = (value: string) => Buffer.from(value).subarray(-OUTPUT_BYTES).toString("utf8");
export function validCommand(command: unknown): command is string {
  return typeof command === "string" && command.trim().length > 0 && command.length <= 2000 &&
    !/[\r\n\0\x01-\x08\x0b-\x1f\x7f]/.test(command);
}

// Suggested commands. Authorization is determined independently by commandPolicy.
export const DIAGNOSTICS: Record<string, string> = {
  directory: "/bin/pwd", system: "/usr/bin/uname -a", clock: "/bin/date -u",
  uptime: "/usr/bin/uptime", disk: "/bin/df -h", processes: "/bin/ps -eo pid,ppid,stat,comm",
};
export const isDiagnostic = (command: string) => commandPolicy(command).risk === "readonly";

type Job = {
  entry: TerminalEntry; marker: string; output: string; actionId: string | null;
  timeout: NodeJS.Timeout; done: Promise<TerminalEntry>; resolve: (entry: TerminalEntry) => void;
  changedByUser: boolean;
};
type Live = {
  shell: IPty; sessionId: string; readyMarker: string; ready: boolean;
  connected: Promise<void>; resolve: () => void; reject: (error: Error) => void;
  startup: NodeJS.Timeout; flush?: NodeJS.Timeout; pending: string; output: string;
  job: Job | null; closed: boolean; screen: InstanceType<typeof xterm.Terminal>; screenWrite: Promise<void>;
};
type PtyFactory = (file: string, args: string[], options: IPtyForkOptions) => IPty;

/** Persistent, session-scoped POSIX shells. Model code cannot bypass the execution policy. */
export class TerminalService {
  private readonly live = new Map<string, Live>();
  private readonly completed = new Map<string, Promise<TerminalEntry>>();

  constructor(private readonly store: Store, private readonly spawnPty: PtyFactory = spawn) {}

  async open(sessionId: string, resourceId: string): Promise<TerminalSession> {
    if (!["local", "ssh"].includes(this.store.resource(resourceId).kind)) throw new ApiFailure(400, "Only host resources support terminals");
    const terminal = this.store.createTerminal(sessionId, resourceId);
    try { await this.connect(sessionId, terminal.id); }
    catch (error) { this.store.disconnectTerminal(sessionId, terminal.id); throw error; }
    return this.store.terminal(sessionId, terminal.id);
  }

  private async connect(sessionId: string, terminalId: string): Promise<Live> {
    const terminal = this.store.terminal(sessionId, terminalId);
    const existing = this.live.get(terminalId);
    if (existing) { await existing.connected; return existing; }
    if (terminal.status !== "ready") throw new ApiFailure(409, "Terminal disconnected; explicitly create a new connection");
    if (this.live.size >= MAX_LIVE_TERMINALS) throw new ApiFailure(409, "Close an unused terminal before opening another (limit 16)");
    const resource = this.store.resource(terminal.resourceId);
    if (resource.status !== "available") throw new ApiFailure(409, "Resource unavailable");
    this.store.setTerminalStatus(sessionId, terminalId, "connecting");
    let shell: IPty;
    try {
      const config = resource.kind === "ssh" ? sshConfig(resource.ssh) : null;
      shell = this.spawnPty(config ? "/usr/bin/ssh" : "/bin/sh", config ? sshArguments(config) : [], {
        cwd: homedir(), name: "xterm-256color", cols: 100, rows: 30,
        env: { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", LANG: "en_US.UTF-8",
          TERM: "xterm-256color", PS1: "", PS2: "" },
      });
    } catch {
      this.store.disconnectTerminal(sessionId, terminalId);
      throw new ApiFailure(503, "Could not start terminal; verify SSH credential and connection configuration");
    }
    const nonce = randomBytes(24).toString("hex");
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const connected = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const live: Live = {
      shell, sessionId, readyMarker: `\x1eLAKE_READY_${nonce}\x1f`, ready: false, connected, resolve, reject,
      startup: setTimeout(() => this.closeLive(terminalId, "Connection timed out"), CONNECT_TIMEOUT_MS),
      pending: "", output: "", job: null, closed: false, screen: new xterm.Terminal({ cols: 100, rows: 30, scrollback: 1000, allowProposedApi: true, logLevel: "off" }), screenWrite: Promise.resolve(),
    };
    this.live.set(terminalId, live);
    shell.onData(data => this.receive(terminalId, live, data));
    shell.onExit(() => { if (!live.closed) this.closeLive(terminalId, "Terminal connection closed", false); });
    shell.write(`stty -echo; PS1='' PS2=''; printf '\\036LAKE_READY_${nonce}\\037'\n`);
    await connected;
    return live;
  }

  private receive(terminalId: string, live: Live, data: string): void {
    if (live.closed) return;
    live.pending += data;
    if (!live.ready) {
      const at = live.pending.indexOf(live.readyMarker);
      if (at < 0) { live.pending = tail(live.pending); return; }
      // Banners and echoed initialization are not user command evidence.
      live.pending = live.pending.slice(at + live.readyMarker.length);
      live.ready = true;
      clearTimeout(live.startup);
      this.store.setTerminalStatus(live.sessionId, terminalId, "ready");
      live.resolve();
    }
    while (live.pending) {
      const job = live.job;
      const prefix = job ? `\x1eLAKE_DONE_${job.marker}:` : null;
      const at = prefix ? live.pending.indexOf(prefix) : -1;
      if (at >= 0 && job && prefix) {
        const end = live.pending.indexOf("\x1f", at + prefix.length);
        if (end < 0) { this.record(live, live.pending.slice(0, at)); live.pending = live.pending.slice(at); break; }
        this.record(live, live.pending.slice(0, at));
        const status = live.pending.slice(at + prefix.length, end);
        live.pending = live.pending.slice(end + 1).replace(/^\r?\n/, "");
        this.finish(terminalId, live, /^\d{1,3}$/.test(status) && Number(status) <= 255 ? Number(status) : null);
        continue;
      }
      // Retain only a possible split marker prefix, so partial output streams immediately.
      let keep = 0;
      if (prefix) for (let n = 1; n < prefix.length; n++) if (live.pending.endsWith(prefix.slice(0, n))) keep = n;
      this.record(live, live.pending.slice(0, live.pending.length - keep));
      live.pending = keep ? live.pending.slice(-keep) : "";
      break;
    }
    if (!live.flush) live.flush = setTimeout(() => { delete live.flush; this.flush(terminalId, live); }, FLUSH_MS);
  }

  private record(live: Live, data: string): void {
    live.output = tail(live.output + data);
    live.screenWrite = live.screenWrite.then(() => new Promise<void>(done => { if (live.closed) done(); else live.screen.write(redact(data), done); }));
    if (live.job) live.job.output = tail(live.job.output + data);
  }

  private flush(terminalId: string, live: Live): void {
    if (live.closed) return;
    this.store.terminalOutput(live.sessionId, terminalId, redact(live.output));
    if (live.job) this.store.appendCommandOutput(live.sessionId, live.job.entry.id, redact(live.job.output));
  }

  private finish(terminalId: string, live: Live, code: number | null, note = "", disconnected = false): void {
    const job = live.job;
    if (!job) return;
    clearTimeout(job.timeout);
    live.job = null;
    const output = redact(job.output + note);
    this.store.finishCommand(live.sessionId, terminalId, job.entry.id, output, job.changedByUser ? null : code, disconnected);
    if (job.actionId) this.store.completeAction(job.actionId,
      job.changedByUser || code === null ? "unknown" : code === 0 ? "succeeded" : "failed", job.changedByUser ? null : code);
    job.resolve({ ...job.entry, output, exitCode: job.changedByUser ? null : code });
    this.completed.delete(job.entry.id);
    if (!disconnected) this.flush(terminalId, live);
  }

  async execute(sessionId: string, terminalId: string, actor: TerminalEntry["actor"], command: string, actionId: string | null = null): Promise<TerminalEntry> {
    if ([process.env.LAKE_WEB_MODEL_KEY, process.env.LAKE_WEB_TOKEN, ...activeSecrets()].some(secret => secret && command.includes(secret)) || command.includes("-----BEGIN")) {
      throw new ApiFailure(400, "Commands must not contain credentials");
    }
    if (!validCommand(command)) throw new ApiFailure(400, "command must be one nonempty line (max 2000 characters)");
    if (actor === "agent") {
      if (actionId) {
        const action = this.store.action(actionId);
        if (action.sessionId !== sessionId || action.resourceId !== this.store.terminal(sessionId, terminalId).resourceId ||
          action.command !== command || action.status !== "running" ||
          (action.terminalId !== null && (action.terminalId !== terminalId || action.contextVersion !== this.store.terminal(sessionId, terminalId).contextVersion)) ||
          this.store.db.prepare("SELECT 1 FROM terminalEntries WHERE actionId=?").get(actionId)) {
          throw new ApiFailure(403, "Command is not authorized by this approval");
        }
      } else if (!isDiagnostic(command)) throw new ApiFailure(403, "This Agent command requires single-use approval");
    }
    const live = await this.connect(sessionId, terminalId);
    // Re-check ownership after connection and model waits. No queued input survives takeover.
    const entry = this.store.beginCommand(sessionId, terminalId, actor, command, actionId);
    let resolve!: (entry: TerminalEntry) => void;
    const done = new Promise<TerminalEntry>(yes => { resolve = yes; });
    const job: Job = {
      entry, marker: randomBytes(24).toString("hex"), output: "", actionId, done, resolve, changedByUser: false,
      timeout: setTimeout(() => this.closeLive(terminalId, "Command timed out; inspect actual state before retrying"), COMMAND_TIMEOUT_MS),
    };
    live.job = job;
    this.completed.set(entry.id, done);
    live.output = tail(live.output + `\r\n${actor === "agent" ? "终端专员" : "你"} > ${command}\r\n`);
    try {
      const policy = commandPolicy(command);
      const executable = policy.risk === "readonly" ? policy.safeCommand! : command;
      live.shell.write(`eval ${quote(executable)}; __lake_code=$?; printf '\\036LAKE_DONE_${job.marker}:%s\\037\\n' "$__lake_code"\n`);
      this.flush(terminalId, live);
    } catch { this.closeLive(terminalId, "Failed to send command; outcome unknown"); }
    return entry;
  }

  async wait(sessionId: string, terminalId: string, entryId: string): Promise<TerminalEntry> {
    this.store.terminal(sessionId, terminalId);
    const waiting = this.completed.get(entryId);
    if (waiting) return waiting;
    return this.store.commandEntry(sessionId, terminalId, entryId);
  }

  control(sessionId: string, terminalId: string, holder: TerminalSession["holder"]): TerminalSession {
    const terminal = this.store.controlTerminal(sessionId, terminalId, holder);
    const live = this.live.get(terminalId);
    if (holder === "user" && live?.job && live.job.entry.actor === "agent") {
      live.job.changedByUser = true;
      this.store.addMessage(sessionId, "system", "你已接管终端；专员不会再发送输入。当前命令仍在运行，可手动输入或中断，其结果需核查。");
    }
    return terminal;
  }

  async screen(sessionId: string, terminalId: string, mode = "tail", lines = 80, maxChars = 20000): Promise<string> {
    this.store.terminal(sessionId, terminalId);
    const live = this.live.get(terminalId);
    if (!live) return this.store.history(sessionId, terminalId).output.slice(-maxChars);
    await live.screenWrite;
    const buffer = live.screen.buffer.active;
    const end = mode === "cursor_before" ? buffer.baseY + buffer.cursorY + 1 : mode === "viewport" ? buffer.viewportY + live.screen.rows : buffer.length;
    const start = mode === "viewport" ? buffer.viewportY : Math.max(0, end - Math.min(1000, lines));
    const output: string[] = [];
    for (let i = start; i < end; i++) output.push(buffer.getLine(i)?.translateToString(true) || "");
    return output.join("\n").slice(-Math.min(100000, maxChars));
  }
  agentInput(sessionId: string, terminalId: string, data: string): void {
    const terminal = this.store.terminal(sessionId, terminalId);
    const live = this.live.get(terminalId);
    if (!live || terminal.holder !== "agent" || !["ready", "busy"].includes(terminal.status)) throw new ApiFailure(409, "Terminal is not owned by Agent");
    if (!data || data.length > 4096 || data.includes("\0")) throw new ApiFailure(400, "Invalid terminal input");
    // Raw interactive input cannot preserve the managed command completion contract.
    this.store.setTerminalStatus(sessionId, terminalId, "busy");
    live.shell.write(data);
  }
  input(sessionId: string, terminalId: string, data: string): void {
    const terminal = this.store.terminal(sessionId, terminalId);
    const live = this.live.get(terminalId);
    if (!live || terminal.status !== "busy" || terminal.holder !== "user") throw new ApiFailure(409, "Interactive input requires a running command and user ownership");
    if (!data || data.length > 4096 || data.includes("\0")) throw new ApiFailure(400, "Invalid terminal input");
    if (live.job?.entry.actor === "agent") live.job.changedByUser = true;
    live.shell.write(data);
  }

  resize(sessionId: string, terminalId: string, cols: number, rows: number): void {
    this.store.terminal(sessionId, terminalId);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 300 || rows < 5 || rows > 150) throw new ApiFailure(400, "Invalid terminal dimensions");
    const live = this.live.get(terminalId);
    if (!live) throw new ApiFailure(409, "Terminal disconnected");
    live.shell.resize(cols, rows);
    live.screen.resize(cols, rows);
  }

  interrupt(sessionId: string, terminalId: string): void {
    const live = this.live.get(terminalId);
    if (!live || live.sessionId !== sessionId || !live.job) throw new ApiFailure(409, "No running command in this terminal");
    // Ctrl-C can abort the shell's completion wrapper as well as the foreground job.
    // Close instead of claiming a known result or reusing an unsynchronized shell.
    this.closeLive(terminalId, "Interrupted by user; outcome unknown");
  }

  close(sessionId: string, terminalId: string): void {
    this.store.terminal(sessionId, terminalId);
    if (this.live.has(terminalId)) this.closeLive(terminalId, "Disconnected by user; outcome unknown");
    else this.store.disconnectTerminal(sessionId, terminalId);
  }

  private closeLive(terminalId: string, reason: string, kill = true): void {
    const live = this.live.get(terminalId);
    if (!live || live.closed) return;
    live.closed = true;
    clearTimeout(live.startup);
    if (live.flush) clearTimeout(live.flush);
    this.record(live, live.pending);
    live.pending = "";
    this.store.terminalOutput(live.sessionId, terminalId, redact(live.output + `\r\n[${reason}]\r\n`));
    this.finish(terminalId, live, null, `\n[${reason}]`, true);
    this.store.disconnectTerminal(live.sessionId, terminalId);
    this.live.delete(terminalId);
    void live.screenWrite.finally(() => live.screen.dispose());
    if (!live.ready) live.reject(new ApiFailure(503, "Terminal connection failed; check trusted host key, SSH credential and reachability"));
    if (kill) { try { live.shell.kill("SIGKILL"); } catch { /* Already exited. */ } }
  }

  closeSession(sessionId: string): void {
    for (const [terminalId, live] of this.live) if (live.sessionId === sessionId) this.close(sessionId, terminalId);
  }

  shutdown(): void {
    for (const terminalId of this.live.keys()) this.closeLive(terminalId, "Service stopped; outcome unknown");
  }
}
