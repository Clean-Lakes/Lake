import { EventEmitter } from "node:events";
import type { StdioStream } from "@zcode/server/remote";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import type { JsonValue } from "../../domain/json.js";
import { object, text, type Params } from "../../domain/validation.js";

export class ZCodeProtocol {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    {
      method: string;
      timer: ReturnType<typeof setTimeout>;
      resolve(result: JsonValue): void;
      reject(error: Error): void;
    }
  >();
  private counter = 0;
  private exit: Promise<void>;
  constructor(
    nodePath: string,
    cliPath: string,
    directory: string,
    signal: AbortSignal,
    onEvent: (method: string, params: Params) => void,
    onRequest?: (method: string, params: Params) => Promise<JsonValue>,
    workspace = directory,
    stream?: StdioStream,
  ) {
    signal.throwIfAborted();
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "HOME", "USER", "TMPDIR", "LANG", "SystemRoot", "TEMP", "TMP"])
      if (process.env[name]) env[name] = process.env[name];
    Object.assign(env, {
      NODE_ENV: "production",
      ZCODE_MODEL_TELEMETRY_ENABLED: "false",
      ZCODE_DATA_BASE_DIR: dirname(directory),
      ZCODE_STORAGE_DIR: join(dirname(directory), "storage"),
      ZCODE_SESSION_DB_PATH: join(directory, "sessions.sqlite"),
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(directory, "builtin.json"),
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(directory, "personal.json"),
    });
    if (stream) {
      const child = new EventEmitter();
      Object.assign(child, {
        stdin: stream.stdin,
        stdout: stream.stdout,
        stderr: stream.stderr,
        kill: () => {
          stream.stdin.end();
          return true;
        },
      });
      stream.onClose(() => child.emit("close"));
      this.child = child as unknown as ChildProcessWithoutNullStreams;
    } else
      this.child = spawn(
        nodePath,
        [cliPath, "app-server", "--cwd", workspace, "--surface", "desktop"],
        { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"], shell: false },
      );
    // Raw SDK diagnostics can contain prompt/provider data and never enter Lake's UI/logs.
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        const message = object(JSON.parse(line));
        if (message.id !== undefined && message.method) {
          const reply = (value: Params) => {
            if (!this.child.stdin.destroyed)
              this.child.stdin.write(JSON.stringify({ id: message.id, ...value }) + "\n");
          };
          void Promise.resolve()
            .then(() => {
              if (!onRequest) throw new Error("Unsupported host request");
              return onRequest(text(message, "method"), object(message.params));
            })
            .then(
              (result) => reply({ result }),
              () => reply({ error: { code: -32601, message: "Host request unavailable" } }),
            );
          return;
        }
        if (message.id !== undefined) {
          const key = String(message.id),
            pending = this.pending.get(key);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(key);
          if (message.error)
            pending.reject(
              new Error(
                `ZCode 协议请求失败（${pending.method}，${String(object(message.error).code)}）`,
              ),
            );
          else pending.resolve(message.result ?? null);
        } else if (message.method) onEvent(text(message, "method"), object(message.params));
      } catch {
        this.fail(new Error("ZCode 返回了无效协议数据"));
        this.child.kill("SIGTERM");
      }
    });
    this.child.stdin.on("error", () => this.fail(new Error("ZCode 输入通道关闭")));
    this.child.on("error", () => this.fail(new Error("无法启动 ZCode 源码运行时")));
    const abort = () => this.child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    this.exit = new Promise((resolve) =>
      this.child.on("close", () => {
        signal.removeEventListener("abort", abort);
        lines.close();
        this.fail(new Error("ZCode 运行时已退出"));
        onEvent("runtime.closed", {});
        resolve();
      }),
    );
    if (signal.aborted) abort();
  }
  call(method: string, params: Params): Promise<JsonValue> {
    const number = ++this.counter,
      id = String(number);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`ZCode 协议响应超时（${method}）`));
        this.child.kill("SIGTERM");
      }, 15000);
      timer.unref();
      this.pending.set(id, { method, timer, resolve, reject });
      this.child.stdin.write(JSON.stringify({ id: number, method, params }) + "\n");
    });
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    timer.unref();
    try {
      await this.exit;
    } finally {
      clearTimeout(timer);
    }
  }
}
