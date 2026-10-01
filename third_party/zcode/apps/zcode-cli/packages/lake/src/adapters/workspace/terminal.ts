import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { userInfo } from "node:os";
import type { Readable, Writable } from "node:stream";
import { redact, type View } from "../../domain/validation.js";
import { shellQuote, terminalCommand } from "../../domain/workspace.js";
import { registeredRoot } from "./files.js";
import { DelimitedStream } from "./stream.js";

const NUL = Buffer.from([0]), MAX_OUTPUT = 64 * 1024, COMMAND_TIMEOUT = 90000;
export class LocalTerminal {
  readonly id = randomBytes(16).toString("hex");
  readonly user = userInfo().username;
  private readonly child: ChildProcess;
  private readonly input: Writable;
  private readonly stdout: DelimitedStream;
  private readonly stderr: DelimitedStream;
  private readonly control: DelimitedStream;
  private directory: string;
  private running = false;
  private closed = false;
  private closePromise?: Promise<void>;
  constructor(readonly root: string) {
    this.directory = root;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TMPDIR", "TEMP", "LANG", "LC_ALL", "TERM", "GOPATH", "GOROOT", "GOCACHE"]) if (process.env[key]) env[key] = process.env[key];
    const windows = process.platform === "win32";
    this.child = spawn(windows ? "powershell.exe" : "sh", windows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"] : [], { cwd: root, env, shell: false, detached: !windows, stdio: windows ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"] });
    this.input = this.child.stdin as Writable;
    this.stdout = new DelimitedStream(this.child.stdout as Readable);
    this.stderr = new DelimitedStream(this.child.stderr as Readable);
    this.control = windows ? this.stdout : new DelimitedStream(this.child.stdio[3] as Readable);
    this.child.on("error", () => { this.closed = true; this.stdout.end(); this.stderr.end(); this.control.end(); });
    this.child.on("close", () => { this.closed = true; this.stdout.end(); this.stderr.end(); this.control.end(); });
    this.input.on("error", () => { void this.close(); });
  }
  view(): View { return { id: this.id, root: this.root, user: this.user, directory: this.directory, running: this.running, closed: this.closed }; }
  async run(command: string, signal: AbortSignal): Promise<View> {
    terminalCommand(command); await registeredRoot(this.root); signal.throwIfAborted();
    if (this.closed || this.running) throw new Error("终端已关闭或已有命令正在执行");
    this.running = true;
    const workingDirectory = this.directory, nonce = randomBytes(16).toString("hex"), marker = Buffer.from(`\0${nonce}\0`), start = Date.now();
    const controller = new AbortController(), abort = () => controller.abort(), stop = () => { void this.close(); };
    signal.addEventListener("abort", abort, { once: true }); controller.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(abort, COMMAND_TIMEOUT);
    try {
      if (signal.aborted) abort(); controller.signal.throwIfAborted();
      const output = this.stdout.read(marker, MAX_OUTPUT), errors = this.stderr.read(marker, MAX_OUTPUT);
      const fields = (async () => {
        // Windows 的控制字段复用 stdout；必须等正文边界被消费后再读取。
        if (process.platform === "win32") await output;
        const exit = await this.control.read(NUL, 16), directory = await this.control.read(NUL, 8192);
        if (exit.truncated || directory.truncated || !/^-?\d+$/u.test(exit.data.toString())) throw new Error("终端状态协议无效");
        return { exit: Number(exit.data.toString()), directory: directory.data.toString() };
      })();
      void output.catch(() => {}); void errors.catch(() => {}); void fields.catch(() => {});
      let script: string;
      if (process.platform === "win32") {
        const encoded = Buffer.from(command).toString("base64");
        script = `$global:LASTEXITCODE=0; '' | ForEach-Object { . ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))) }; $lakeExit=if($?){$LASTEXITCODE}else{if($LASTEXITCODE){$LASTEXITCODE}else{1}}; [Console]::Out.Write("$([char]0)${nonce}$([char]0)$lakeExit$([char]0)$((Get-Location).Path)$([char]0)"); [Console]::Error.Write("$([char]0)${nonce}$([char]0)")\r\n`;
      } else script = `eval ${shellQuote(command)} </dev/null; _lake_exit=$?; command printf '\\000${nonce}\\000'; command printf '\\000${nonce}\\000' >&2; command printf '%s\\000%s\\000' "$_lake_exit" "$(command pwd -P)" >&3\n`;
      this.input.write(script);
      const [out, err, state] = await Promise.all([output, errors, fields]);
      controller.signal.throwIfAborted();
      this.directory = state.directory;
      return { command: redact(command, 4000), working_directory: workingDirectory, next_directory: state.directory, user: this.user, stdout: redact(out.data.toString(), MAX_OUTPUT), stderr: redact(err.data.toString(), MAX_OUTPUT), exit_code: state.exit, duration_ms: Date.now() - start, truncated: out.truncated || err.truncated, status: state.exit === 0 ? "completed" : "failed", error: "" };
    } catch {
      await this.close();
      return { command: redact(command, 4000), working_directory: workingDirectory, next_directory: workingDirectory, user: this.user, stdout: "", stderr: "", exit_code: -1, duration_ms: Date.now() - start, truncated: false, status: "unknown", error: "终端执行中断或超时，结果未知；此 Shell 已关闭，请核对后再启动" };
    } finally { this.running = false; clearTimeout(timer); signal.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", stop); }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.closePromise = (async () => {
      const done = once(this.child, "close").catch(() => {});
      const kill = (signal: NodeJS.Signals) => {
        try { if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, signal); else this.child.kill(signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      };
      kill("SIGTERM"); const timer = setTimeout(() => kill("SIGKILL"), 2000); timer.unref();
      this.input.end(); await done; clearTimeout(timer);
    })();
    return this.closePromise;
  }
}
