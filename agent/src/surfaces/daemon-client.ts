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
  constructor(readonly info: DaemonInfo) {}
  async request(
    method: string,
    path: string,
    data?: unknown,
    expectedRevision = 0,
    requestId = crypto.randomUUID(),
  ): Promise<any> {
    const response = await fetch(this.info.origin + "/api/v1/" + path, {
      method,
      headers: {
        Authorization: "Bearer " + this.info.token,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST"
        ? { body: JSON.stringify({ requestId, expectedRevision, data }) }
        : {}),
      signal: AbortSignal.timeout(30000),
    });
    const value = (await response.json()) as any;
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
      return (await this.request("GET", "health")).nonce === this.info.nonce;
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
    const client = new DaemonClient(info);
    if (await client.healthy()) return client;
  }
  const entry = new URL(
    import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js",
    import.meta.url,
  ).pathname;
  const child = spawn(
    process.execPath,
    [
      ...(entry.endsWith(".ts") ? ["--import", "tsx"] : []),
      entry,
      "serve",
      "--home",
      home,
    ],
    {
      detached: true,
      stdio: "ignore",
      cwd: new URL("../../", import.meta.url).pathname,
    },
  );
  child.unref();
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await readInfo(home);
    if (value) {
      const client = new DaemonClient(value);
      if (await client.healthy()) return client;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new LakeError("timeout", "Daemon did not become ready");
}
