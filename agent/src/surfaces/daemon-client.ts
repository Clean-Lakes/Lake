import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { requireCondition, LakeError } from "../domain/errors.js";
import { errorCodes } from "../domain/errors.js";
export interface DaemonInfo {
  origin: string;
  token: string;
  nonce: string;
  pid: number;
}
export class DaemonClient {
  private reconnecting: Promise<void> | undefined;
  constructor(
    public info: DaemonInfo,
    private readonly home?: string,
  ) {}
  async request(
    method: string,
    path: string,
    data?: unknown,
    expectedRevision = 0,
    requestId = crypto.randomUUID(),
    signal?: AbortSignal,
  ): Promise<any> {
    try {
      return await this.send(
        method,
        path,
        data,
        expectedRevision,
        requestId,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw new LakeError("cancelled", "请求已取消");
      if (
        !this.home ||
        !(error instanceof LakeError) ||
        !["timeout", "prerequisite_missing", "unauthorized"].includes(
          error.code,
        )
      )
        throw error;
      // Reuse the entire command, including its request ID. The API's durable
      // receipt prevents a lost POST response from executing the command twice.
      this.reconnecting ??= this.reconnect().finally(() => {
        this.reconnecting = undefined;
      });
      await this.reconnecting;
      if (signal?.aborted) throw new LakeError("cancelled", "请求已取消");
      return this.send(method, path, data, expectedRevision, requestId, signal);
    }
  }
  private async reconnect(): Promise<void> {
    const current = await readInfo(this.home!);
    if (current) {
      const candidate = new DaemonClient(current);
      if (await candidate.healthy()) {
        this.info = current;
        return;
      }
    }
    this.info = (await connectOrStartDaemon(this.home!)).info;
  }
  private async send(
    method: string,
    path: string,
    data: unknown,
    expectedRevision: number,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<any> {
    let response: Response;
    try {
      response = await fetch(this.info.origin + "/api/v1/" + path, {
        method,
        headers: {
          Authorization: "Bearer " + this.info.token,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST"
          ? { body: JSON.stringify({ requestId, expectedRevision, data }) }
          : {}),
        signal: AbortSignal.any([
          AbortSignal.timeout(path === "health" ? 2000 : 30000),
          ...(signal ? [signal] : []),
        ]),
      });
    } catch (error) {
      if (signal?.aborted) throw new LakeError("cancelled", "请求已取消");
      throw new LakeError(
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "prerequisite_missing",
        "暂时无法连接 Lake 后台服务",
        true,
      );
    }
    let value: any;
    try {
      value = await response.json();
    } catch {
      throw new LakeError("model_protocol_error", "后台返回了无法解析的响应");
    }
    if (!response.ok) {
      const error = value.error;
      throw new LakeError(
        errorCodes.includes(error?.code) ? error.code : "invalid_input",
        typeof error?.message === "string" ? error.message : "Request failed",
      );
    }
    return value;
  }
  async healthy(): Promise<boolean> {
    try {
      return (
        (await this.send("GET", "health", undefined, 0, crypto.randomUUID()))
          .nonce === this.info.nonce
      );
    } catch {
      return false;
    }
  }
}
async function readInfo(home: string): Promise<DaemonInfo | undefined> {
  try {
    const path = join(home, "agent/runtime/daemon.json"),
      st = await lstat(path);
    requireCondition(
      st.isFile() &&
        !st.isSymbolicLink() &&
        st.uid === process.getuid?.() &&
        (st.mode & 0o077) === 0 &&
        st.size < 4096,
      "scope_denied",
    );
    const value = JSON.parse(await readFile(path, "utf8"));
    requireCondition(
      /^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin) &&
        typeof value.token === "string" &&
        typeof value.nonce === "string" &&
        Number.isInteger(value.pid),
      "scope_denied",
    );
    process.kill(value.pid, 0);
    return value;
  } catch {
    return undefined;
  }
}
export async function connectOrStartDaemon(
  home: string,
): Promise<DaemonClient> {
  const info = await readInfo(home);
  if (info) {
    const client = new DaemonClient(info, home);
    if (await client.healthy()) return client;
  }
  const entry = new URL(
    import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js",
    import.meta.url,
  ).pathname;
  // A chat can outlive a build. Starting its own archived cli.js would roll
  // the daemon back after a restart. Managed releases use the stable signed
  // launcher, which always points at the current build.
  const releaseRoot = new URL("../../", import.meta.url);
  let launcher: string | undefined;
  if (
    /\/lake-agent-runtime\/releases\/0\.0\.1-[a-f0-9]{64}\/$/.test(
      releaseRoot.pathname,
    )
  ) {
    const candidate = new URL("../../../lake", releaseRoot).pathname;
    try {
      const st = await lstat(candidate);
      if (
        st.isFile() &&
        !st.isSymbolicLink() &&
        st.uid === process.getuid?.() &&
        st.mode & 0o111
      )
        launcher = candidate;
    } catch {
      /* Standalone copied runtimes retain the direct entry fallback. */
    }
  }
  const child = spawn(
    launcher ?? process.execPath,
    launcher
      ? ["serve", "--home", home]
      : [
          ...(entry.endsWith(".ts") ? ["--import", "tsx"] : []),
          entry,
          "serve",
          "--home",
          home,
        ],
    {
      detached: true,
      stdio: "ignore",
      cwd: releaseRoot.pathname,
    },
  );
  child.unref();
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await readInfo(home);
    if (value) {
      const client = new DaemonClient(value, home);
      if (await client.healthy()) return client;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new LakeError("timeout", "Daemon did not become ready");
}
