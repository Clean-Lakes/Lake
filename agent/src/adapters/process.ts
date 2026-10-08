import { spawn } from "node:child_process";
import { LakeError } from "../domain/errors.js";
export async function runProcess(
  file: string,
  args: string[],
  options: {
    signal: AbortSignal;
    timeoutMs?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    maxBytes?: number;
  },
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    let stdout = "",
      stderr = "",
      bytes = 0,
      settled = false;
    const finish = (error?: LakeError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else resolve({ stdout, stderr, exitCode: child.exitCode ?? 1 });
    };
    const abort = () => finish(new LakeError("cancelled"));
    const timer = setTimeout(
      () => finish(new LakeError("timeout")),
      options.timeoutMs ?? 30000,
    );
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: Buffer) => {
      bytes += Buffer.byteLength(data);
      if (bytes > (options.maxBytes ?? 65536)) {
        finish(new LakeError("output_limit"));
        return;
      }
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      bytes += Buffer.byteLength(data);
      if (bytes > (options.maxBytes ?? 65536)) {
        finish(new LakeError("output_limit"));
        return;
      }
      stderr += data.toString();
    });
    child.on("error", () => finish(new LakeError("capability_unavailable")));
    child.on("close", () => finish());
  });
}
