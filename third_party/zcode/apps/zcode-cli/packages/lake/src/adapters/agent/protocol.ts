import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { JsonValue } from "../../domain/json.js";
import { object, text, type Params } from "../../domain/validation.js";

export class ZCodeProtocol {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve(result: JsonValue): void; reject(error: Error): void }>();
  private counter = 0;
  private exit: Promise<void>;
  constructor(nodePath: string, cliPath: string, directory: string, signal: AbortSignal, onEvent: (method: string, params: Params) => void) {
    signal.throwIfAborted();
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "HOME", "USER", "TMPDIR", "LANG", "SystemRoot", "TEMP", "TMP"]) if (process.env[name]) env[name] = process.env[name];
    Object.assign(env, { NODE_ENV: "production", ZCODE_MODEL_TELEMETRY_ENABLED: "false", ZCODE_DATA_BASE_DIR: directory, ZCODE_STORAGE_DIR: join(directory, "storage"), ZCODE_SESSION_DB_PATH: join(directory, "sessions.sqlite"), ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(directory, "builtin.json"), ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(directory, "personal.json") });
    this.child = spawn(nodePath, [cliPath, "app-server", "--cwd", directory, "--surface", "desktop"], { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    // Raw SDK diagnostics can contain prompt/provider data and never enter Lake's UI/logs.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", line => {
      try {
        const message = object(JSON.parse(line));
        if (message.id !== undefined && message.method) {
          this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Use Lake tools and approval" } }) + "\n");
          return;
        }
        if (message.id !== undefined) {
          const key = String(message.id), pending = this.pending.get(key);
          if (!pending) return; this.pending.delete(key);
          if (message.error) pending.reject(new Error("ZCode 协议请求失败"));
          else pending.resolve(message.result ?? null);
        } else if (message.method) onEvent(text(message, "method"), object(message.params));
      } catch { this.fail(new Error("ZCode 返回了无效协议数据")); this.child.kill("SIGTERM"); }
    });
    this.child.stdin.on("error", () => this.fail(new Error("ZCode 输入通道关闭")));
    this.child.on("error", () => this.fail(new Error("无法启动 ZCode 源码运行时")));
    const abort = () => this.child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    this.exit = new Promise(resolve => this.child.on("close", () => {
      signal.removeEventListener("abort", abort); lines.close(); this.fail(new Error("ZCode 运行时已退出")); onEvent("runtime.closed", {}); resolve();
    }));
    if (signal.aborted) abort();
  }
  call(method: string, params: Params): Promise<JsonValue> {
    const number = ++this.counter, id = String(number);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id: number, method, params }) + "\n");
    });
  }
  private fail(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
  async close(): Promise<void> {
    this.child.stdin.end(); this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000); timer.unref();
    try { await this.exit; } finally { clearTimeout(timer); }
  }
}
