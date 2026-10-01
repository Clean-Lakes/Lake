import { spawn } from "node:child_process";
import { redact, type View } from "../../domain/validation.js";

const OUTPUT_LIMIT = 256 * 1024;
const TERMINATION_GRACE_MS = 2000;
export interface ProcessOptions {
  cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Uint8Array;
  signal: AbortSignal; timeoutMS?: number;
}
export async function runProcess(executable: string, args: string[], options: ProcessOptions): Promise<View> {
  options.signal.throwIfAborted();
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "", stderr = "", truncated = false, stopped = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const append = (previous: string, chunk: Buffer): string => {
      if (previous.length + chunk.length > OUTPUT_LIMIT) truncated = true;
      return (previous + chunk.toString("utf8")).slice(0, OUTPUT_LIMIT);
    };
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    const stop = () => {
      stopped = true; child.kill("SIGTERM");
      grace ??= setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
      grace.unref();
    };
    const timer = setTimeout(stop, options.timeoutMS ?? 120_000);
    options.signal.addEventListener("abort", stop, { once: true });
    const cleanup = () => { clearTimeout(timer); if (grace) clearTimeout(grace); options.signal.removeEventListener("abort", stop); };
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", (code, signal) => {
      cleanup();
      resolve({ stdout: redact(stdout), stderr: redact(stderr), exit_code: code ?? -1, duration_ms: Date.now() - start, truncated, status: stopped || signal ? "unknown" : code === 0 ? "completed" : "failed", error: stopped ? "命令已取消或超时；执行结果未知" : "" });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    // Abort may have occurred between admission and listener registration.
    if (options.signal.aborted) stop();
  });
}
