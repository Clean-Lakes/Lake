import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { sql as v1 } from "./migrations/v1.js";
import { sql as v2 } from "./migrations/v2.js";
import { sql as v3 } from "./migrations/v3.js";
import { sql as v4 } from "./migrations/v4.js";
import { sql as v5 } from "./migrations/v5.js";
import { sql as v6 } from "./migrations/v6.js";
import { sql as v7 } from "./migrations/v7.js";
import { sql as v8 } from "./migrations/v8.js";
import { sql as v8Backfill } from "./migrations/v8backfill.js";
import { sql as v9 } from "./migrations/v9.js";
import { sql as v10 } from "./migrations/v10.js";
import { sql as v11 } from "./migrations/v11.js";
import { sql as v12 } from "./migrations/v12.js";
import { sql as v13 } from "./migrations/v13.js";
import { sql as v14 } from "./migrations/v14.js";
import { sql as v15 } from "./migrations/v15.js";
import { sql as v16 } from "./migrations/v16.js";
import { sql as v18 } from "./migrations/v18.js";
import type { View } from "../../domain/validation.js";

export const SCHEMA_VERSION = 19;
const migrations = ["", v1, v2, v3, v4, v5, v6, v7, v8 + v8Backfill, v9, v10, v11, v12, v13, v14, v15, v16, "", v18, ""];
export const newID = (): string => randomBytes(16).toString("hex");
export const timeView = (row: View): View => {
  const result = { ...row };
  for (const field of ["created_at", "updated_at", "started_at", "finished_at", "archived_at", "timestamp"]) {
    if (typeof result[field] === "number") result[field] = new Date(result[field] as number).toISOString();
  }
  return result;
};
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Lake 数据目录不是普通目录");
  await chmod(path, 0o700);
}
export class LakeDatabase {
  private constructor(readonly root: string, private readonly db: DatabaseSync) {}
  static async open(root: string): Promise<LakeDatabase> {
    root = resolve(root);
    await privateDirectory(root);
    const path = join(root, "lake.db");
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Lake 数据库不是普通文件");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const db = new DatabaseSync(path);
    try {
      await chmod(path, 0o600);
      db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      const store = new LakeDatabase(root, db);
      await store.migrate();
      return store;
    } catch (error) { db.close(); throw error; }
  }
  all(sql: string, ...values: SQLInputValue[]): View[] {
    return this.db.prepare(sql).all(...values) as View[];
  }
  one(sql: string, ...values: SQLInputValue[]): View {
    const row = this.db.prepare(sql).get(...values);
    if (!row) throw new Error("lake: not found");
    return row as View;
  }
  run(sql: string, ...values: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...values).changes);
  }
  transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = body(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
  private version(): number { return Number(this.one("PRAGMA user_version").user_version); }
  private column(table: string, field: string, declaration: string): void {
    const fields = this.all(`PRAGMA table_info(${table})`);
    if (!fields.length) throw new Error(`${table} table missing`);
    if (!fields.some(item => item.name === field)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${field} ${declaration}`);
  }
  private async migrate(): Promise<void> {
    const version = this.version();
    if (version > SCHEMA_VERSION) throw new Error(`database schema ${version} is newer than supported schema ${SCHEMA_VERSION}`);
    if (version === SCHEMA_VERSION) return;
    if (version > 0) {
      const backup = join(this.root, `lake.db.pre-v${version + 1}-${newID()}.bak`);
      // Reserve a private file before SQLite writes a backup containing private history.
      const { open } = await import("node:fs/promises");
      const file = await open(backup, "wx", 0o600); await file.close();
      this.db.prepare("VACUUM INTO ?").run(backup);
    }
    this.db.exec("PRAGMA foreign_keys=OFF");
    try {
      this.transaction(() => {
        const lockedVersion = this.version();
        if (lockedVersion > SCHEMA_VERSION) throw new Error("database upgraded by another process");
        for (let target = lockedVersion + 1; target <= SCHEMA_VERSION; target++) {
          if (target === 17) this.column("conversation_event", "tool_call_id", "TEXT NOT NULL DEFAULT ''");
          else if (target === 19) this.column("conversation_summary", "task_state", "TEXT NOT NULL DEFAULT 'null'");
          else this.db.exec(migrations[target]);
          this.db.exec(`PRAGMA user_version=${target}`);
        }
        if (this.all("PRAGMA foreign_key_check").length) throw new Error("migration foreign key check failed");
      });
    } finally { this.db.exec("PRAGMA foreign_keys=ON"); }
  }
}
