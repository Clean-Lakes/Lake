import { Worker } from "node:worker_threads";
import { LakeError } from "../domain/errors.js";
import type { DbCommand, StorePort } from "../domain/ports.js";
export class SqliteStore implements StorePort {
  private readonly worker: Worker;
  private counter = 0;
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown[]) => void;
      reject: (e: unknown) => void;
    }
  >();
  private readonly ready: Promise<void>;
  constructor(path: string) {
    this.worker = new Worker(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "./sqlite-worker.ts"
          : "./sqlite-worker.js",
        import.meta.url,
      ),
      { workerData: { path } },
    );
    this.ready = new Promise((resolve, reject) => {
      this.worker.once("message", (m) => {
        if (m.ready) resolve();
        else reject(new LakeError("storage_error"));
      });
      this.worker.once("error", () => reject(new LakeError("storage_error")));
    });
    this.worker.on(
      "message",
      (m: { id?: number; results?: unknown[]; error?: string }) => {
        if (m.id === undefined) return;
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error
          ? p.reject(
              new LakeError(
                m.error === "conflict" ? "conflict" : "storage_error",
              ),
            )
          : p.resolve(m.results ?? []);
      },
    );
    this.worker.on("error", () => {
      for (const p of this.pending.values())
        p.reject(new LakeError("storage_error"));
      this.pending.clear();
    });
    this.worker.on("exit", () => {
      this.closed = true;
      for (const p of this.pending.values())
        p.reject(new LakeError("storage_error"));
      this.pending.clear();
    });
  }
  async transact(commands: DbCommand[]): Promise<unknown[]> {
    await this.ready;
    if (this.closed) throw new LakeError("storage_error");
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, commands });
    });
  }
  async get<T>(table: string, id: string): Promise<T | undefined> {
    return (await this.transact([{ op: "get", table, id }]))[0] as
      | T
      | undefined;
  }
  async list<T>(table: string): Promise<T[]> {
    return (await this.transact([{ op: "list", table }]))[0] as T[];
  }
  async close(): Promise<void> {
    await this.ready;
    await this.transact([]);
    this.closed = true;
    await this.worker.terminate();
  }
}
