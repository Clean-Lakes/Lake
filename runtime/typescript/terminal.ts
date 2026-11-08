import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { isSea } from "node:sea";
import type {LakeSSH,TerminalDevice} from "./ssh";
import type { Resource, SessionEvent, TerminalEntry, TerminalSession } from "../../web-agent/shared/contracts";
import { commandPolicy, dangerConfirmation } from "../../web-agent/shared/command-policy";
import { HttpError, id, LakeStore, now } from "./store";
import type { LakeSecurity } from "./security";
import { digest } from "./tasks";

const root = () => isSea() ? join(dirname(process.execPath), "lake-runtime") : __dirname;
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const limit = 256 * 1024;
type Live = { pty: TerminalDevice; terminal: TerminalSession; signature: string; partial: string; raw: string; ready: boolean; closed: boolean;
  marker: string; jobMarker: string; suppressEcho: boolean; jobStarted: boolean; inputPending: boolean; jobRaw: string; job?: TerminalEntry; timer?: ReturnType<typeof setTimeout>; flush?: ReturnType<typeof setTimeout>; exited: Promise<void>; resolveExit: () => void };

/** Human PTY ownership is separate from Worker authority. Opening a console never binds an agent. */
export class LakeTerminals {
  private live = new Map<string, Live>();
  private grants = new Map<string, string>();
  private reservations = 0;
  private closing = false;
  constructor(readonly store: LakeStore, readonly security: LakeSecurity, readonly scrub: (value: string, live?: boolean) => string,
    readonly publish: (event: SessionEvent) => void, readonly ssh?:LakeSSH) {
    // Old processes are not trusted handles. Retain output; never resume or kill a saved PID.
    for (const terminal of store.list<TerminalSession>("terminals")) {
      if (terminal.status !== "disconnected") {
        terminal.status = "disconnected"; terminal.holder = null; terminal.interactive = false;
        store.put("terminals", terminal.id, terminal);
      }
    }
    for (const entry of store.list<TerminalEntry>("terminalEntries")) if (entry.status === "running") {
      entry.status = "unknown"; entry.finishedAt = now(); store.put("terminalEntries", entry.id, entry);
    }
  }
  get supported() { return process.platform === "darwin" && existsSync(join(root(), "native/node-pty/prebuilds", `${process.platform}-${process.arch}`, "pty.node")); }
  private emit(terminal: TerminalSession) { this.store.put("terminals", terminal.id, terminal); this.publish(this.store.event(terminal.sessionId, "terminal")); }
  private resource(resourceId: string) { return this.store.require<Resource>("resources", resourceId); }
  private signature(resource: Resource) { return digest([resource.id, resource.projectId, resource.kind, resource.settings, resource.ssh, this.store.get("resourceRevisions", resource.id)]); }
  private projectTerminal(sessionId: string, terminalId: string) {
    const session = this.store.session(sessionId), terminal = this.store.require<TerminalSession>("terminals", terminalId);
    if (this.store.session(terminal.sessionId).projectId !== session.projectId || this.resource(terminal.resourceId).projectId !== session.projectId) throw new HttpError(404, "终端不属于此项目");
    return terminal;
  }
  private permission(sessionId: string, terminal: TerminalSession) { return digest([terminal.generation, terminal.contextVersion, this.store.session(sessionId).options]); }
  private access(sessionId: string, terminalId: string, write = false) {
    const terminal = this.projectTerminal(sessionId, terminalId);
    if (sessionId !== terminal.sessionId && this.grants.get(sessionId + ":" + terminalId) !== this.permission(sessionId, terminal)) throw new HttpError(403, "采用此终端需要明确授权，或授权已经失效");
    if (write) {
      this.security.check();
      const live = this.live.get(terminalId);
      if (!live || live.closed || !live.ready || terminal.status === "connecting") throw new HttpError(409, "终端已断开或尚未就绪");
      if (live.signature !== this.signature(this.resource(terminal.resourceId))) throw new HttpError(409, "终端资源连接已改变，请重新连接");
    }
    return terminal;
  }
  resourceTerminals(resourceId: string) { this.resource(resourceId); return this.store.list<TerminalSession>("terminals").filter((terminal) => terminal.resourceId === resourceId); }
  available(sessionId: string) {
    const session = this.store.session(sessionId);
    return this.store.list<TerminalSession>("terminals").filter((terminal) => this.store.session(terminal.sessionId).projectId === session.projectId && terminal.status !== "disconnected")
      .map((terminal) => ({ ...terminal, ownerTitle: this.store.session(terminal.sessionId).title }));
  }
  context(resourceId: string) {
    this.security.check(); const resource = this.resource(resourceId);
    if (!["local", "ssh"].includes(resource.kind)) throw new HttpError(400, "此资源不支持交互终端");
    const existing = this.resourceTerminals(resourceId).findLast((terminal) => terminal.interactive && terminal.holder === "user" && terminal.status !== "disconnected");
    if (existing) return { sessionId: existing.sessionId };
    let sessionId = this.store.get<string>("terminalScopes", resourceId);
    if (!sessionId) this.store.transaction(() => {
      const session = this.store.createSession(resource.projectId); session.title = `${resource.name} 终端`;
      this.store.put("sessions", session.id, session); this.store.put("terminalScopes", resourceId, session.id); sessionId = session.id;
    });
    return { sessionId: sessionId! };
  }
  async open(sessionId: string, data: Record<string, any>) {
    this.security.check();
    if (!this.supported) throw new HttpError(501, "当前平台尚未接入持续终端");
    const session = this.store.session(sessionId), resource = this.resource(data.resourceId);
    if (resource.projectId !== session.projectId) throw new HttpError(404, "资源不属于此项目");
    if (!["local","ssh"].includes(resource.kind)) throw new HttpError(400, "此资源不支持终端");
    const remote=resource.kind==="ssh"; if(remote&&!this.ssh)throw new HttpError(501,"SSH 适配器未接入");
    if (resource.status !== "available") throw new HttpError(409, "此资源尚未完成迁移核验，请使用 TS 项目工作区");
    const shell = data.shell ?? (remote?resource.ssh?.shell:resource.settings?.shell) ?? (remote?"bash":"zsh");
    if (!["sh", "bash", "zsh", "fish"].includes(shell)) throw new HttpError(400, "Shell 必须是 sh、bash、zsh 或 fish");
    const program = ["/bin/" + shell, "/usr/bin/" + shell, "/opt/homebrew/bin/" + shell].find(existsSync);
    if (!program&&!remote) throw new HttpError(400, "所选 Shell 未安装");
    if (this.closing || this.live.size + this.reservations >= 16) throw new HttpError(409, "最多同时连接 16 个终端");
    this.reservations++;
    try {
      const cwd = remote?null:await this.store.workspace(session.projectId);
      this.security.check();
      if (this.closing) throw new HttpError(409, "终端服务正在停止");
      const terminal: TerminalSession = { id: id(), sessionId, resourceId: resource.id, generation: id(), status: "connecting", holder: "user", contextVersion: 1,
        shell, cwd, createdAt: now(), outputCapturedAt: null, interactive: true };
      const marker = id().replaceAll("-", "");
      const hooks = shell === "sh" ? "" : readFileSync(join(root(), "hooks", shell + ".txt"), "utf8").replace("__lake_recording=;", "__lake_recording=; __lake_managed=;").replace("local __lake_status=$?;", "local __lake_status=$?; __lake_managed=;");
      const shPrompt = `if [ -n "\${BASH_VERSION-}" ]; then PROMPT_COMMAND='printf "\\033]9003;%s;%s\\007" "$?" "$PWD"'; PS1='[$PWD]$ '; else PS1='$(printf "\\033]9003;%s;%s\\007" "$?" "$PWD")[$PWD]$ '; fi`;
      const initialization = shell === "fish"
        ? `stty -echo; ${remote?'cd -- "$HOME"; ':''}${hooks}\nset -g __lake_interactive 1; set -g __lake_managed 1; stty echo; printf '\\036LAKE_READY_${marker}\\037'; set -e __lake_managed`
        : `stty -echo; ${remote?'cd -- "$HOME"; ':''}${hooks}\n${shell === "sh" ? shPrompt : shell === "bash" ? "PS1='[\\u@\\h \\w]\\$ '" : "PS1='[%n@%m %~]%# '"}; PS2='> '; HISTFILE=/dev/null; __lake_managed=1; stty echo; printf '\\036LAKE_READY_${marker}\\037'; __lake_managed=`;
      const env: Record<string, string> = { HOME: this.store.home, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor" };
      // Staging command is environment data, not an echoed command containing hook bodies.
      env.__lake_init = initialization;
      const args = shell === "bash" ? ["--noprofile", "--norc", "-i"] : shell === "zsh" ? ["-f", "-i"] : shell === "fish" ? ["--no-config", "--private", "-i"] : ["-i"];
      const command="/bin/sh -c "+quote("export __lake_init="+quote(initialization)+"; exec "+shell+" "+args.map(quote).join(" "));
      const pty:TerminalDevice = remote?this.ssh!.terminal(sessionId,resource,command):(createRequire(join(root(), "server.cjs"))(join(root(), "native/node-pty")) as typeof import("node-pty")).spawn(program!, args, { cwd:cwd!, env, cols: 100, rows: 30, name: "xterm-256color" });
      let resolveExit!: () => void; const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
      const live: Live = { pty, terminal, marker, signature: this.signature(resource), partial: "", raw: "", jobRaw: "", jobMarker: "", suppressEcho: false, jobStarted: false, inputPending: false, ready: false, closed: false, exited, resolveExit };
      this.live.set(terminal.id, live); this.emit(terminal);
      pty.onData((value) => this.receive(live, value));
      pty.onExit(() => { this.finish(live); live.resolveExit(); });
      live.timer = setTimeout(() => { if (!live.ready) void this.stop(live); }, remote?150000:8000);
      if(!remote)pty.write('eval "$__lake_init"\r');
      else { const launch=setInterval(()=>{if(live.closed||live.ready){clearInterval(launch);return;}try{pty.write('eval "$__lake_init"\r');clearInterval(launch);}catch{}},100);launch.unref(); }
      return terminal;
    } finally { this.reservations--; }
  }
  private save(live: Live) {
    if (live.closed) return;
    const output = this.scrub(live.raw, true);
    this.store.put("terminalOutput", live.terminal.id, output);
    if (live.job) { live.job.output = this.scrub(live.jobRaw, true); this.store.put("terminalEntries", live.job.id, live.job); }
    live.terminal.outputCapturedAt = now(); this.emit(live.terminal);
  }
  private receive(live: Live, value: string) {
    if (live.closed) return;
    let source = live.partial + value; live.partial = "";
    if (!live.ready) {
      const marker = "\x1eLAKE_READY_" + live.marker + "\x1f", at = source.indexOf(marker);
      if (at < 0) { live.partial = source.slice(-16384); return; }
      source = source.slice(at + marker.length); live.ready = true; clearTimeout(live.timer);
    }
    // Retain split control frames; shell observations never issue permission or agent grants.
    while (source) {
      const match = /\x1b\]900[34];|\x1eLAKE_(?:DONE_[a-z0-9]+:|START_[a-z0-9]+)/i.exec(source);
      if (!match) {
        let keep = 0;
        for (let size = 1; size <= Math.min(64, source.length); size++) if (/^(?:\x1b\](?:900[34]?)?;?|\x1b|\x1e(?:LAKE_(?:DONE|START)_[a-z0-9]*:?)?)$/i.test(source.slice(-size))) keep = size;
        this.plain(live, source.slice(0, source.length - keep)); live.partial = keep ? source.slice(-keep) : ""; break;
      }
      this.plain(live, source.slice(0, match.index)); source = source.slice(match.index);
      const end = source.indexOf(source[0] === "\x1b" ? "\x07" : "\x1f");
      if (end < 0) { if (source.length < 16384) live.partial = source; else this.plain(live, "[invalid shell frame]"); break; }
      const frame = source.slice(0, end); source = source.slice(end + 1);
      if (frame.startsWith("\x1b]9003;")) {
        const state = /^\x1b\]9003;(\d+);([^\0\x1b\r\n]*)$/.exec(frame);
        if (state && Number(state[1]) <= 255 && isAbsolute(state[2])) {
          live.terminal.cwd = state[2]; live.inputPending = false; live.terminal.status = "ready";
          if (live.job && (live.jobStarted || live.job.stopRequestedAt)) this.complete(live, Number(state[1]));
        }
      } else if (frame.startsWith("\x1b]9004;") && !live.job) {
        const command = this.scrub(frame.slice(7));
        if (command && command.length <= 16000) { live.job = this.entry(live, command); live.jobStarted = true; }
      } else if (frame === "\x1eLAKE_START_" + live.jobMarker) {
        live.suppressEcho = false; live.jobStarted = true;
      } else if (frame === "\x1eLAKE_DONE_" + live.jobMarker + ":" + frame.split(":").at(-1)) {
        const code = Number(frame.split(":").at(-1)); if (Number.isInteger(code) && code >= 0 && code <= 255) this.complete(live, code);
      }
    }
    clearTimeout(live.flush); live.flush = setTimeout(() => this.save(live), 25);
  }
  private plain(live: Live, value: string) { if (live.suppressEcho) return; live.raw = (live.raw + value).slice(-limit); if (live.job) { live.jobRaw = (live.jobRaw + value).slice(-limit); live.job.output = this.scrub(live.jobRaw, true); } }
  private entry(live: Live, command: string): TerminalEntry {
    const entry: TerminalEntry = { id: id(), terminalId: live.terminal.id, actor: "user", command: this.scrub(command), output: "", exitCode: null, status: "running", generation: live.terminal.generation,
      cwd: live.terminal.cwd, createdAt: now(), startedAt: now(), finishedAt: null, originSessionId: null };
    live.jobRaw = ""; live.terminal.status = "busy"; this.store.put("terminalEntries", entry.id, entry); return entry;
  }
  private complete(live: Live, code: number) {
    if (live.job) { live.job.status = "completed"; live.job.exitCode = code; live.job.finishedAt = now(); this.store.put("terminalEntries", live.job.id, live.job); live.job = undefined; }
    live.inputPending = false; live.suppressEcho = false; live.jobStarted = false; live.terminal.status = "ready";
    this.save(live);
  }
  private finish(live: Live) {
    if (live.closed) return;
    clearTimeout(live.timer); clearTimeout(live.flush); if(!live.ready&&live.pty.error)live.raw="\r\n"+live.pty.error+"\r\n"; this.save(live); live.closed = true;
    if (live.job) { live.job.status = "unknown"; live.job.finishedAt = now(); this.store.put("terminalEntries", live.job.id, live.job); live.job = undefined; }
    live.terminal.status = "disconnected"; live.terminal.holder = null; live.terminal.interactive = false; this.live.delete(live.terminal.id); this.emit(live.terminal);
  }
  history(sessionId: string, terminalId: string, outputOnly = false) {
    const terminal = this.projectTerminal(sessionId, terminalId);
    return { terminal, output: this.scrub(this.store.get<string>("terminalOutput", terminalId) ?? ""), entries: outputOnly ? [] : this.store.list<TerminalEntry>("terminalEntries").filter((entry) => entry.terminalId === terminalId) };
  }
  adopt(sessionId: string, terminalId: string, data: Record<string, any>) {
    this.security.check(); const terminal = this.projectTerminal(sessionId, terminalId);
    if (data.accept !== true || data.generation !== terminal.generation || terminal.status === "disconnected") throw new HttpError(409, "需要明确采用当前终端，连接版本不能变化");
    if (data.bind) throw new HttpError(501, "Agent 终端绑定仍在迁移中，当前可使用手动终端");
    this.grants.set(sessionId + ":" + terminalId, this.permission(sessionId, terminal)); return terminal;
  }
  control(sessionId: string, terminalId: string, holder: unknown) {
    const terminal = this.access(sessionId, terminalId, true);
    if (holder === "agent") throw new HttpError(501, "Agent 终端交接仍在迁移中，当前可使用手动终端");
    if (holder !== null && holder !== "user") throw new HttpError(400, "无效的终端输入所有者");
    terminal.holder = holder; this.live.get(terminalId)!.terminal.holder = holder; this.emit(terminal); return terminal;
  }
  input(sessionId: string, terminalId: string, data: unknown) {
    const terminal = this.access(sessionId, terminalId, true);
    if (terminal.holder !== "user") throw new HttpError(409, "请先接管终端输入");
    if (typeof data !== "string" || data.length > 65536 || data.includes("\0")) throw new HttpError(400, "无效的终端输入");
    const live = this.live.get(terminalId)!; live.inputPending = true; live.pty.write(data); return { accepted: true };
  }
  resize(sessionId: string, terminalId: string, cols: unknown, rows: unknown) {
    this.access(sessionId, terminalId, true);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || Number(cols) < 2 || Number(rows) < 2 || Number(cols) > 500 || Number(rows) > 300) throw new HttpError(400, "无效的终端尺寸");
    this.live.get(terminalId)!.pty.resize(Number(cols), Number(rows)); return { resized: true };
  }
  command(sessionId: string, terminalId: string, data: Record<string, any>) {
    const terminal = this.access(sessionId, terminalId, true), live = this.live.get(terminalId)!;
    if (data.actor !== "user") throw new HttpError(403, "Agent 命令需要独立操作审批");
    if (terminal.holder !== "user" || terminal.status !== "ready" || live.job || live.inputPending) throw new HttpError(409, "请等待终端空闲并接管输入");
    if (typeof data.command !== "string" || !data.command.trim() || data.command.length > 16000 || /[\0\r\n\x1b]/.test(data.command)) throw new HttpError(400, "无效的命令");
    const policy = commandPolicy(data.command);
    if (policy.risk !== "readonly" && data.confirmed !== true) throw new HttpError(400, "变更命令需要本次确认");
    if (policy.risk === "dangerous" && data.confirmation !== dangerConfirmation(this.resource(terminal.resourceId).name)) throw new HttpError(400, "危险命令需要再次确认准确目标");
    const entry = live.job = this.entry(live, data.command); this.plain(live, this.scrub(data.command) + "\r\n");
    live.jobMarker = id().replaceAll("-", ""); live.jobStarted = false; live.suppressEcho = true; live.inputPending = true; this.emit(terminal);
    const command = policy.safeCommand ?? data.command;
    const frame = live.terminal.shell === "fish"
      ? `set -g __lake_managed 1; printf '\\036LAKE_START_${live.jobMarker}\\037'; eval ${quote(command)}; set -l __lake_code $status; printf '\\036LAKE_DONE_${live.jobMarker}:%s\\037' $__lake_code; set -e __lake_managed\r`
      : `__lake_managed=1; printf '\\036LAKE_START_${live.jobMarker}\\037'; eval ${quote(command)}; __lake_code=$?; printf '\\036LAKE_DONE_${live.jobMarker}:%s\\037' "$__lake_code"; __lake_managed=\r`;
    live.pty.write(frame); return entry;
  }
  interrupt(sessionId: string, terminalId: string, data?: Record<string, any>) {
    const terminal = this.access(sessionId, terminalId, true), live = this.live.get(terminalId)!;
    if (data && (data.generation !== terminal.generation || data.entryId !== live.job?.id)) throw new HttpError(409, "命令或终端连接版本已改变");
    if (terminal.holder !== "user") throw new HttpError(409, "请先接管终端输入");
    if (live.job) { live.job.stopRequestedAt = now(); this.store.put("terminalEntries", live.job.id, live.job); }
    live.pty.write("\x03"); return { interrupted: true, stopRequested: true };
  }
  async disconnect(sessionId: string, terminalId: string) {
    this.access(sessionId, terminalId); const live = this.live.get(terminalId);
    if (live) await this.stop(live); return { disconnected: true };
  }
  private async stop(live: Live) {
    // Only this process's registered child handle can be signalled.
    const signal = (value: NodeJS.Signals) => { if (!live.closed) { try { if(live.pty.pid)process.kill(-live.pty.pid,value);else live.pty.kill(value); } catch { try { live.pty.kill(value); } catch {} } } };
    signal("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([live.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 500); })]); clearTimeout(timer);
    signal("SIGKILL");
    await Promise.race([live.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 500); })]); clearTimeout(timer);
    this.finish(live);
  }
  async close() { this.closing = true; await Promise.all([...this.live.values()].map((live) => this.stop(live))); }
}
