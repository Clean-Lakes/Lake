import { readFile, lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { LakeStore, HttpError, privateDirectory } from "./store";
import { digest } from "./tasks";
import { createHash, randomBytes } from "node:crypto";

export type MemorySearchDocument = {
  id: string;
  scopeKey: string;
  revision: number;
  title: string;
  body: string;
};
type Indexed = {
  key: string;
  entryId: string;
  scopeKey: string;
  project: string;
  fingerprint: string;
  observationId?: number;
  deleting?: boolean;
};
/** Claude-Mem indexes qualified notes. Lake remains their publisher and read authority. */
export class ClaudeMemIndex {
  private queue: Promise<unknown> = Promise.resolve();
  private endpoint: string;
  constructor(
    private store: LakeStore,
    origin: string,
    private guard: () => void,
    private owned?: ChildProcess,
    private token?: string,
  ) {
    const url = new URL(origin);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new HttpError(400, "Claude-Mem must use a loopback origin");
    this.endpoint = url.origin;
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
  private async request(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) {
    this.guard();
    const response = await fetch(this.endpoint + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        ...(this.token ? { Authorization: "Bearer " + this.token } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok)
      throw new HttpError(503, "Claude-Mem local index request failed");
    const reader = response.body?.getReader();
    if (!reader)
      throw new HttpError(503, "Claude-Mem returned an empty response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 262144) {
        await reader.cancel();
        throw new HttpError(503, "Claude-Mem response exceeds budget");
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as any;
  }
  async health() {
    return this.request("/api/health");
  }
  private project(scopeKey: string) {
    return (
      "lake-" +
      digest([this.store.get("settings", "layeredMemoryStoreId"), scopeKey])
    );
  }
  private rows() {
    return this.store
      .list<Indexed>("claudeMemIndex")
      .filter((row) => row.key.startsWith(digest(this.endpoint) + ":"));
  }
  private async remove(row: Indexed) {
    row = { ...row, deleting: true };
    this.store.put("claudeMemIndex", row.key, row);
    // Replay an uncertain index write with the same fingerprint. Upstream returns
    // its committed ID; a missing original becomes a harmless marker then is deleted.
    if (!row.observationId) {
      const saved = await this.request("/api/memory/save", {
        project: row.project,
        title: "Withdrawn Lake cache entry",
        text: "Withdrawn Lake cache entry",
        metadata: {
          sourceFingerprint: row.fingerprint,
          platformSource: "lake",
        },
      });
      if (!Number.isSafeInteger(saved.id) || saved.project !== row.project)
        throw new HttpError(503, "Claude-Mem index identity changed");
      row.observationId = saved.id;
      this.store.put("claudeMemIndex", row.key, row);
    }
    const observations = await this.request("/api/observations/batch", {
      ids: [row.observationId],
    });
    const observation = Array.isArray(observations)
      ? observations.find((value: any) => value.id === row.observationId)
      : undefined;
    if (observation) {
      let metadata: any;
      try {
        metadata =
          typeof observation.metadata === "string"
            ? JSON.parse(observation.metadata)
            : observation.metadata;
      } catch {}
      if (
        observation.project !== row.project ||
        metadata?.sourceFingerprint !== row.fingerprint
      )
        throw new HttpError(
          503,
          "Claude-Mem cache observation has a different owner",
        );
      await this.request(
        "/api/observation/" + row.observationId,
        undefined,
        "DELETE",
      );
    }
    this.store.delete("claudeMemIndex", row.key);
  }
  forget(ids: string[]) {
    return this.serial(async () => {
      for (const row of this.rows())
        if (ids.includes(row.entryId) || row.deleting) await this.remove(row);
    });
  }
  rank(
    documents: MemorySearchDocument[],
    scopeKeys: string[],
    query: string,
    validate: () => void,
  ) {
    return this.serial(async () => {
      validate();
      const byId = new Map(documents.map((doc) => [doc.id, doc]));
      for (const row of this.rows())
        if (
          row.deleting ||
          (scopeKeys.includes(row.scopeKey) && !byId.has(row.entryId))
        )
          await this.remove(row);
      for (const doc of documents) {
        validate();
        const key = digest(this.endpoint) + ":" + doc.id,
          project = this.project(doc.scopeKey),
          fingerprint = digest([
            project,
            doc.id,
            doc.revision,
            doc.title,
            doc.body,
          ]);
        const previous = this.store.get<Indexed>("claudeMemIndex", key);
        if (
          previous?.fingerprint === fingerprint &&
          !previous.deleting &&
          previous.observationId
        )
          continue;
        if (previous) await this.remove(previous);
        const row: Indexed = {
          key,
          entryId: doc.id,
          scopeKey: doc.scopeKey,
          project,
          fingerprint,
        };
        this.store.put("claudeMemIndex", key, row);
        const saved = await this.request("/api/memory/save", {
          project,
          title: doc.title,
          text: `Lake reference ${doc.id}@${doc.revision}\n\n${doc.body}`,
          metadata: {
            sourceFingerprint: fingerprint,
            platformSource: "lake",
            lakeEntryId: doc.id,
            lakeRevision: doc.revision,
          },
        });
        if (
          saved.success !== true ||
          !Number.isSafeInteger(saved.id) ||
          saved.project !== project
        )
          throw new HttpError(
            503,
            "Claude-Mem did not commit the scoped index note",
          );
        row.observationId = saved.id;
        this.store.put("claudeMemIndex", key, row);
        validate();
      }
      const ranked: string[] = [];
      for (const scopeKey of scopeKeys) {
        validate();
        const project = this.project(scopeKey),
          params = new URLSearchParams({ query, project, limit: "12" });
        const result = await this.request("/api/search?" + params);
        const text = (result.content ?? [])
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text)
          .join("\n");
        const ids = [...text.matchAll(/^\|\s*#?(\d+)\s*\|/gm)]
          .map((match) => Number(match[1]))
          .slice(0, 12);
        if (!ids.length) continue;
        const observations = await this.request("/api/observations/batch", {
          ids,
        });
        for (const id of ids) {
          const observation = Array.isArray(observations)
            ? observations.find((value: any) => value.id === id)
            : undefined;
          const row = this.rows().find(
            (row) =>
              !row.deleting &&
              row.observationId === id &&
              row.project === project &&
              byId.has(row.entryId),
          );
          let metadata: any;
          try {
            metadata =
              typeof observation?.metadata === "string"
                ? JSON.parse(observation.metadata)
                : observation?.metadata;
          } catch {}
          if (
            row &&
            observation?.project === project &&
            metadata?.sourceFingerprint === row.fingerprint &&
            !ranked.includes(row.entryId)
          )
            ranked.push(row.entryId);
        }
      }
      validate();
      return ranked;
    });
  }
  async close() {
    await this.queue;
    if (this.owned && !this.owned.killed) {
      this.owned.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) =>
          this.owned!.once("exit", () => resolve()),
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (this.owned.exitCode === null) this.owned.kill("SIGKILL");
    }
  }
}

export async function openClaudeMemIndex(store: LakeStore, guard: () => void) {
  const root = join(store.home, "claude-mem"),
    configPath = join(root, "index.json");
  let config: any;
  try {
    const info = await lstat(configPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    )
      throw new Error("private config required");
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error: any) {
    if (error.code === "ENOENT") return;
    throw new HttpError(
      503,
      "Claude-Mem private configuration needs verification",
    );
  }
  if (config.enabled !== true) return;
  if (
    config.version !== 1 ||
    !Number.isSafeInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535
  )
    throw new HttpError(400, "Invalid Claude-Mem local port");
  const origin = "http://127.0.0.1:" + config.port;
  if (config.managed !== true)
    throw new HttpError(
      400,
      "Claude-Mem requires the isolated Lake-managed runtime",
    );
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new HttpError(
      503,
      "Managed Claude-Mem has only been validated on macOS arm64",
    );
  const bun = resolve(
      root,
      "engine/node_modules/@oven/bun-darwin-aarch64/bin/bun",
    ),
    worker = resolve(
      root,
      "engine/node_modules/claude-mem/plugin/scripts/worker-service.cjs",
    ),
    preload = join(root, "guard.cjs");
  for (const path of [bun, worker, preload])
    if (!(await lstat(path)).isFile())
      throw new HttpError(503, "Claude-Mem runtime is missing");
  for (const [path, expected] of [
    [bun, config.bunSHA256],
    [worker, config.workerSHA256],
    [preload, config.guardSHA256],
  ])
    if (
      typeof expected !== "string" ||
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex") !== expected
    )
      throw new HttpError(503, "Claude-Mem runtime checksum changed");
  const data = join(root, "data");
  await privateDirectory(data);
  const settings = {
    CLAUDE_MEM_DATA_DIR: data,
    CLAUDE_MEM_WORKER_HOST: "127.0.0.1",
    CLAUDE_MEM_WORKER_PORT: String(config.port),
    CLAUDE_MEM_OBSERVER_ENABLED: "false",
    CLAUDE_MEM_CHROMA_ENABLED: "false",
    CLAUDE_MEM_TELEMETRY: "0",
    CLAUDE_MEM_NOTION_ENABLED: "false",
    CLAUDE_MEM_TELEGRAM_ENABLED: "false",
    CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED: "false",
    CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: "false",
    CLAUDE_MEM_WORK_STATE_ENABLED: "false",
    CLAUDE_MEM_TRANSCRIPTS_ENABLED: "false",
    CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: "false",
    CLAUDE_MEM_MEDIA_INFERENCE_ENABLED: "false",
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: "",
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: "",
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: "",
  };
  // Exact flags are also saved because upstream reads some options from its
  // private settings file. No global IDE hooks, credentials or cloud profile.
  await (
    await import("node:fs/promises")
  ).writeFile(join(data, "settings.json"), JSON.stringify(settings), {
    mode: 0o600,
  });
  const token = randomBytes(32).toString("hex"),
    tokenPath = join(root, "token");
  const credential = await open(tokenPath, "w", 0o600);
  await credential.writeFile(token);
  await credential.close();
  const log = await open(join(data, "lake-worker.log"), "a", 0o600);
  const child = spawn(bun, ["--preload", preload, worker, "--daemon"], {
    cwd: data,
    env: {
      PATH: "/usr/bin:/bin",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      DO_NOT_TRACK: "1",
      LAKE_CLAUDE_MEM_TOKEN_FILE: tokenPath,
      CLAUDE_CONFIG_DIR: join(root, "claude-config"),
      ...settings,
    },
    stdio: ["ignore", log.fd, log.fd],
  });
  await log.close();
  const index = new ClaudeMemIndex(store, origin, guard, child, token);
  let failure: unknown;
  child.on("error", (error) => {
    failure = error;
  });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (failure || child.exitCode !== null) break;
    try {
      const health = await index.health();
      if (health.pid !== child.pid)
        throw new Error("port belongs to another process");
      if (health.version !== "15.10.0")
        throw new Error("unexpected index version");
      await index.forget([]);
      return index;
    } catch (error) {
      failure = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await index.close();
  throw new HttpError(503, "Claude-Mem local worker did not become ready");
}
