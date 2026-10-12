import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AIImage, AIView, Resource } from "../../shared/contracts.js";
import { commandPolicy, dangerConfirmation } from "../../shared/command-policy.js";
import { activeModel } from "./model-config.js";
import { ApiFailure, dataDirectory, Store } from "./store.js";
import { TerminalService, validCommand } from "./terminal.js";

type Frame = { id?: string; method?: string; session?: string; data?: Record<string, unknown>; result?: unknown; error?: string; callback?: string; approved?: boolean; event?: { session: string; type: string; data: unknown } };
type Options = { profile: string; runtime: string; asset_ref: string; container_id: string; terminal_id: string; userPrompt: string; contextWindow: number; maxOutput: number; maxSteps: number };
const emptyOptions: Options = { profile: "core", runtime: "local", asset_ref: "", container_id: "", terminal_id: "", userPrompt: "", contextWindow: 64000, maxOutput: 8192, maxSteps: 500 };
const terminalNames = new Set(["runtimeCommandExec","open_ssh_terminal", "ssh_terminal_send", "ssh_terminal_read", "ssh_terminal_expect", "ssh_terminal_key", "list_ssh_terminals", "close_ssh_terminal", "read_terminal_screen", "terminal_send_input", "terminal_send_key", "terminal_expect", "terminal_execute_command"]);

export class GoAI {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly callbacks = new Map<string, AbortController>();
  private readonly options = new Map<string, Options>();
  private closing = false;
  private starting: Promise<void> | null = null;
  constructor(private readonly store: Store, private readonly terminals: TerminalService) {}
  configured(): boolean { return activeModel() !== null; }
  private start(): Promise<void> {
    if (this.closing) return Promise.reject(Error("AI 服务正在停止"));
    if (this.child) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((yes, no) => {
      const project = ["../../", "../../../"].map(path => resolve(fileURLToPath(new URL(path, import.meta.url)))).find(path => (existsSync(join(path, "web/index.html")) || existsSync(join(path, "web/dist/index.html"))))!;
      const candidates = [process.env.LAKE_AI_BACKEND, join(project, "dist/lake-ai"), join(project, "lake-ai"), resolve(project, "../bin/lake-ai")].filter((v): v is string => !!v);
      const binary = candidates.find(path => existsSync(path));
      if (!binary) { no(Error("缺少 Go AI 服务，请运行 pnpm --dir web-agent build:ai")); return; }
      const child = spawn(binary, ["--data", join(dataDirectory(), "ai")], { stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      child.once("spawn", yes);
      child.once("error", () => { this.fail(); no(Error("无法启动 Go AI 服务")); });
      child.once("exit", () => this.fail());
      child.stderr.on("data", () => { /* Worker diagnostics never include request or credential bodies. */ });
      child.stdin.on("error", () => this.fail());
      const lines = createInterface({ input: child.stdout });
      lines.on("line", line => {
        if (line.length > 32 * 1024 * 1024) { child.kill(); return; }
        let frame: Frame; try { frame = JSON.parse(line) as Frame; } catch { child.kill(); return; }
        if (frame.event) {
          const { session, type } = frame.event;
          try {
            this.store.session(session);
            if (type === "approval") this.store.setSessionStatus(session, "waiting_approval");
            else if (type === "done") {
              const status = (frame.event.data as { status?: string })?.status;
              this.store.setSessionStatus(session, status === "completed" || status === "cancelled" ? "completed" : "failed");
            } else { this.store.touchAI(session); }
          } catch { /* A deleted session has no subscriber. */ }
          return;
        }
        if (frame.callback) {
          if (frame.method === "callbackCancel") { this.callbacks.get(frame.callback)?.abort(); return; }
          const controller = new AbortController(); this.callbacks.set(frame.callback, controller);
          void this.bridge(frame.session!, frame.method!, frame.data ?? {}, frame.approved === true, controller.signal).then(
            result => this.write({ callback: frame.callback!, result }),
            error => this.write({ callback: frame.callback!, error: error instanceof ApiFailure ? error.message : "Terminal operation failed" }),
          ).finally(() => this.callbacks.delete(frame.callback!));
          return;
        }
        if (frame.id) {
          const request = this.pending.get(frame.id); if (!request) return;
          clearTimeout(request.timer); this.pending.delete(frame.id);
          if (frame.error) request.reject(new ApiFailure(409, frame.error)); else request.resolve(frame.result);
        }
      });
    }).finally(() => { this.starting = null; });
    return this.starting;
  }
  private fail() {
    this.child = null;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(Error("Go AI 服务已停止；在途操作不会重放")); }
    this.pending.clear(); for (const controller of this.callbacks.values()) controller.abort(); this.callbacks.clear();
    if (this.closing) return;
    for (const session of this.store.catalog().sessions) if (["investigating", "waiting_approval"].includes(session.status)) this.store.setSessionStatus(session.id, "failed");
  }
  private write(frame: Frame) { if (this.child && !this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(frame)}\n`); }
  async request<T = unknown>(method: string, session = "", data: object = {}): Promise<T> {
    await this.start();
    if (method === "abort" && session) for (const terminal of this.store.snapshot(session).terminals) if (terminal.holder === "agent" && terminal.status === "busy") this.terminals.close(session, terminal.id);
    const id = randomUUID();
    return new Promise<T>((yes, no) => {
      const timer = setTimeout(() => { this.pending.delete(id); no(Error("Go AI 请求超时")); if (session) void this.request("abort", session).catch(() => {}); }, method === "chat" ? 24 * 3600_000 : 300_000);
      this.pending.set(id, { resolve: value => yes(value as T), reject: no, timer });
      this.write({ id, method, session, data: data as Record<string, unknown> });
    });
  }
  async configure(sessionId: string, updates?: Partial<Options>) {
    if (updates && Object.keys(updates).some(key => !(key in emptyOptions))) throw new ApiFailure(400, "Unsupported AI option");
    const persisted = this.store.aiOptions(sessionId);
    const options = { ...emptyOptions, ...persisted, ...this.options.get(sessionId), ...updates } as Options;
    if (!["core", "terminal2", "db-query-editor"].includes(options.profile) || !["local", "ssh", "container"].includes(options.runtime)) throw new ApiFailure(400, "Invalid AI profile/runtime");
    if (typeof options.userPrompt !== "string" || options.userPrompt.length > 30000 || !Number.isInteger(options.contextWindow) || options.contextWindow < 2048 || options.contextWindow > 2000000 || !Number.isInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 500) throw new ApiFailure(400, "Invalid AI options");
    if (options.asset_ref) this.store.assertSessionResource(sessionId, options.asset_ref);
    if (options.terminal_id) this.store.terminal(sessionId, options.terminal_id);
    const model = activeModel(); if (!model) throw new ApiFailure(400, "尚未配置模型");
    const assets = this.store.snapshot(sessionId).resources.map(resource => ({ id: resource.id, name: resource.name, kind: resource.kind, ...(resource.ssh ? { ssh: resource.ssh } : {}), settings: resource.settings ?? {} }));
    await this.request("configure", sessionId, { ...options, assets, conversationOnly: this.store.snapshot(sessionId).actions.some(action => action.status === "pending"), model: { ...model, contextWindow: options.contextWindow, maxOutput: options.maxOutput } });
    this.options.set(sessionId, options); this.store.saveAIOptions(sessionId, options);
    return options;
  }
  async runTurn(sessionId: string, message: string, mentioned: Array<{ id: string }> = [], _collectTerminal = true, images: AIImage[] = [], extraReferences: Record<string, unknown>[] = []): Promise<void> {
    try {
      await this.configure(sessionId);
      const snapshot = this.store.snapshot(sessionId);
      const context = { conversation: snapshot.messages.slice(-12).map(m => ({ role: m.role, text: m.text.slice(0, 2000) })), pendingOperations: snapshot.actions.filter(a => a.status === "pending").map(a => ({ resource: this.store.resource(a.resourceId).name, command: a.command, risk: a.risk, reason: a.reason, impact: a.impact, verification: a.verification })), recentCommands: this.store.recentHistory(sessionId).map(({ entry, resourceId }) => ({ resource: this.store.resource(resourceId).name, command: entry.command, output: entry.output.slice(-2000), exitCode: entry.exitCode })) };
      const modelMessage = `[LAKE_SESSION_CONTEXT]\n${JSON.stringify(context)}\n[USER_MESSAGE]\n${message}`;
      const previousView = await this.snapshot(sessionId);
      const view = await this.request<AIView>("chat", sessionId, { message: modelMessage, images, references: [...mentioned.map(item => { const r = this.store.resource(item.id); return { asset_ref: r.id, name: r.name, type: r.kind }; }), ...extraReferences] });
      const newText = view.cards.slice(Math.max(0, view.cards.length - Math.max(0, view.totalCards - previousView.totalCards))).filter(card => card.type === "message" && card.content).at(-1)?.content;
      // Go owns the streamed transcript. A compact final message keeps legacy conversation exports useful.
      if (newText) this.store.addMessage(sessionId, "assistant", newText);
      if (this.store.snapshot(sessionId).actions.some(action => action.status === "pending")) this.store.setSessionStatus(sessionId, "waiting_approval");
    } catch (error) {
      if (this.closing) return;
      if (this.child) { const view = await this.snapshot(sessionId).catch(() => null); if (view?.status === "cancelled") { this.store.setSessionStatus(sessionId, "completed"); return; } }
      this.store.addMessage(sessionId, "system", error instanceof Error ? error.message : "Go AI 未完成本轮请求");
      this.store.setSessionStatus(sessionId, "failed");
    }
  }
  async snapshot(sessionId: string): Promise<AIView> { return this.request<AIView>("snapshot", sessionId); }
  shutdown() { this.closing = true; const child = this.child; this.child = null; child?.stdin.end(); setTimeout(() => child?.kill("SIGTERM"), 1000).unref(); }
  private async bridge(sessionId: string, name: string, args: Record<string, unknown>, approved: boolean, signal: AbortSignal): Promise<unknown> {
    const snapshot = this.store.snapshot(sessionId);
    const terminalId = typeof args.terminal_id === "string" ? args.terminal_id : "";
    const target = terminalId ? this.store.terminal(sessionId, terminalId) : null;
    const asText = (value: unknown) => typeof value === "string" ? value : "";
    if (name === "policy") {
      const callName = asText(args.name); const params = args.arguments as Record<string, unknown>;
      const selected = asText(params.terminal_id) || terminalId;
      const terminal = selected ? this.store.terminal(sessionId, selected) : null;
      const command = asText(params.command) || asText(params.input) || asText(params.initial_input);
      let risk: string | undefined;
      if (["shell", "terminal_execute_command"].includes(callName)) risk = commandPolicy(command).risk;
      else if (command && commandPolicy(command).risk === "dangerous") risk = "dangerous";
      const fingerprint = createHash("sha256").update(JSON.stringify({ params, terminal, terminals: callName === "shell" ? snapshot.terminals : undefined, resources: snapshot.resources })).digest("hex");
      return { ...(risk ? { risk, safeCommand: commandPolicy(command).safeCommand } : {}), fingerprint, target: terminal ? this.store.resource(terminal.resourceId).name : "" };
    }
    if (name === "runtimeCommandExec") {
      const runtime = asText(args.runtime) || "local";
      const resourceId = asText(args.asset_ref) || snapshot.resources.find(r => r.kind === runtime)?.id;
      if (!resourceId) throw new ApiFailure(400, "No resource for selected shell runtime");
      this.store.assertSessionResource(sessionId, resourceId);
      if (this.store.resource(resourceId).kind !== runtime || !["local", "ssh"].includes(runtime)) throw new ApiFailure(400, "Shell runtime and asset do not match");
      let terminal = snapshot.terminals.find(t => t.resourceId === resourceId && t.status !== "disconnected");
      if (!terminal) { terminal = await this.terminals.open(sessionId, resourceId); this.terminals.control(sessionId, terminal.id, "agent"); }
      return this.bridge(sessionId, "terminal_execute_command", { ...args, terminal_id: terminal.id, intent: "Go Agent Shell 操作" }, approved, signal);
    }
    if (!terminalNames.has(name)) throw new ApiFailure(400, "Unknown terminal bridge tool");
    if (signal.aborted) throw new ApiFailure(409, "AI turn cancelled");
    if (name === "list_ssh_terminals") return snapshot.terminals.filter(t => !args.asset_ref || t.resourceId === args.asset_ref).map(t => ({ ...t, terminal_id: t.id }));
    if (name === "open_ssh_terminal") {
      const resourceId = asText(args.asset_ref); this.store.assertSessionResource(sessionId, resourceId);
      const resource = this.store.resource(resourceId);
      if (!["local", "ssh"].includes(resource.kind)) throw new ApiFailure(400, "Resource is not a host terminal");
      const terminal = await this.terminals.open(sessionId, resourceId);
      this.terminals.control(sessionId, terminal.id, "agent");
      if (asText(args.initial_input)) await this.bridge(sessionId, "ssh_terminal_send", { ...args, input: args.initial_input, terminal_id: terminal.id }, approved, signal);
      return { ...this.store.terminal(sessionId, terminal.id), terminal_id: terminal.id };
    }
    if (!target) throw new ApiFailure(400, "Select a terminal for this AI profile");
    const read = () => this.terminals.screen(sessionId, target.id, asText(args.mode) || "tail", Number(args.lines) || 80, Number(args.max_chars) || 20000);
    if (["read_terminal_screen", "ssh_terminal_read"].includes(name)) return { terminal_id: target.id, text: await read(), status: target.status, mode: args.mode ?? "tail" };
    if (name === "close_ssh_terminal") { if (!approved) throw new ApiFailure(403, "Closing terminal needs approval"); this.terminals.close(sessionId, target.id); return { closed: true }; }
    const send = async (input: string, enter: boolean) => {
      if (!approved) throw new ApiFailure(403, "Terminal input requires explicit approval");
      this.terminals.agentInput(sessionId, target.id, input + (enter && !/[\r\n]$/.test(input) ? "\n" : ""));
    };
    if (name === "terminal_execute_command") {
      const command = asText(args.command); if (!validCommand(command)) throw new ApiFailure(400, "Invalid command");
      if (target.holder !== "agent" || target.status !== "ready") throw new ApiFailure(409, "请先将空闲终端交给 Agent");
      const policy = commandPolicy(command); let actionId: string | null = null;
      if (policy.risk !== "readonly") {
        if (!approved) throw new ApiFailure(403, "Command requires approval");
        const action = this.store.addAction(sessionId, target.resourceId, command, asText(args.intent) || "Go Agent 操作", "按已确认参数执行", "检查实际输出", target.id);
        this.store.decideAction(action.id, "approve", dangerConfirmation(this.store.resource(target.resourceId).name)); actionId = action.id;
      }
      const entry = await this.terminals.execute(sessionId, target.id, "agent", command, actionId);
      if (args.run_in_background === true) return { shell_id: entry.id, entry_id: entry.id, terminal_id: target.id, status: "running" };
      const interrupted = () => { try { this.terminals.close(sessionId, target.id); } catch {} };
      signal.addEventListener("abort", interrupted, { once: true });
      try { const result = await this.terminals.wait(sessionId, target.id, entry.id); if (signal.aborted) throw new ApiFailure(409, "Cancelled; command outcome unknown"); return result; }
      finally { signal.removeEventListener("abort", interrupted); }
    }
    if (name === "ssh_terminal_send" || name === "terminal_send_input") { await send(asText(args.input), args.append_enter === true); return { sent: true }; }
    if (name === "ssh_terminal_key" || name === "terminal_send_key") {
      const keys: Record<string, string> = { enter: "\r", tab: "\t", esc: "\x1b", backspace: "\x7f", delete: "\x1b[3~", ctrl_c: "\x03", ctrl_d: "\x04", ctrl_z: "\x1a", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", home: "\x1b[H", end: "\x1b[F", page_up: "\x1b[5~", page_down: "\x1b[6~", space: " " };
      const key = keys[asText(args.key)]; if (!key) throw new ApiFailure(400, "Unknown terminal key"); await send(key.repeat(Math.max(1, Math.min(100, Number(args.count) || 1))), false); return { sent: true };
    }
    if (name === "ssh_terminal_expect" || name === "terminal_expect") {
      if (asText(args.input)) await send(asText(args.input), args.append_enter === true);
      const patterns = Array.isArray(args.wait_for) ? args.wait_for.filter((p): p is string => typeof p === "string") : [];
      // JS regexes from a model can hang Node; Go evaluates regexes with RE2 before calling the bridge.
      if (args.match === "regex") throw new ApiFailure(400, "Regex terminal expect is evaluated by Go; use contains at the bridge");
      const timeout = Math.max(1, Math.min(300000, Number(args.timeout_ms) || 30000));
      const started = Date.now(); let previous = await read(); let changed = started;
      while (Date.now() - started < timeout) {
        if (signal.aborted) throw new ApiFailure(409, "Terminal wait cancelled");
        const text = await read(); if (text !== previous) { previous = text; changed = Date.now(); }
        const matched = patterns.find(pattern => text.includes(pattern));
        if (matched || !patterns.length && Date.now() - changed >= (Number(args.idle_ms) || 1000) && Date.now() - started >= (Number(args.min_wait_ms) || 100)) return { text, matched: matched ?? null, timed_out: false };
        await new Promise(yes => setTimeout(yes, 100));
      }
      return { text: await read(), timed_out: true };
    }
    throw new ApiFailure(400, "Unknown terminal operation");
  }
}
