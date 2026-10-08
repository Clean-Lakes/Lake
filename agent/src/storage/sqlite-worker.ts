import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync, backup } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { assertTable, tables } from "./schema.js";
import { EventSchema } from "../domain/events.js";
import type { DbCommand } from "../domain/ports.js";
import { publicProjection } from "../domain/schemas.js";
const db = new DatabaseSync(workerData.path, { timeout: 5000 });
db.exec(
  "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
);
export function migrate(): void {
  db.exec(
    readFileSync(
      new URL("./migrations/001-initial.sql", import.meta.url),
      "utf8",
    ),
  );
  const parentColumns: Record<string, string> = {
    environments:
      "lake_id TEXT GENERATED ALWAYS AS (json_extract(payload,'$.lakeId')) VIRTUAL REFERENCES lakes(id) DEFERRABLE INITIALLY DEFERRED",
    resources:
      "lake_id TEXT GENERATED ALWAYS AS (json_extract(payload,'$.lakeId')) VIRTUAL REFERENCES lakes(id) DEFERRABLE INITIALLY DEFERRED, environment_id TEXT GENERATED ALWAYS AS (json_extract(payload,'$.environmentId')) VIRTUAL REFERENCES environments(id) DEFERRABLE INITIALLY DEFERRED",
    services:
      "lake_id TEXT GENERATED ALWAYS AS (json_extract(payload,'$.lakeId')) VIRTUAL REFERENCES lakes(id) DEFERRABLE INITIALLY DEFERRED",
    sessions:
      "lake_id TEXT GENERATED ALWAYS AS (json_extract(payload,'$.lakeId')) VIRTUAL REFERENCES lakes(id) DEFERRABLE INITIALLY DEFERRED, environment_id TEXT GENERATED ALWAYS AS (json_extract(payload,'$.environmentId')) VIRTUAL REFERENCES environments(id) DEFERRABLE INITIALLY DEFERRED",
    tasks:
      "session_id TEXT GENERATED ALWAYS AS (json_extract(payload,'$.sessionId')) VIRTUAL REFERENCES sessions(id) DEFERRABLE INITIALLY DEFERRED",
  };
  for (const table of tables) {
    let extra = parentColumns[table];
    if (
      !extra &&
      ![
        "lakes",
        "resource_grants",
        "specialist_profiles",
        "api_requests",
      ].includes(table)
    )
      extra =
        "session_id TEXT GENERATED ALWAYS AS (json_extract(payload,'$.sessionId')) VIRTUAL REFERENCES sessions(id) DEFERRABLE INITIALLY DEFERRED";
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), payload TEXT NOT NULL CHECK(json_valid(payload))${extra ? ", " + extra : ""}) STRICT;`,
    );
  }
}
migrate();
parentPort!.postMessage({ ready: true });
function execute(command: DbCommand): unknown {
  if (command.op === "cursor") {
    const statement = db.prepare(
      "SELECT COALESCE(MAX(sequence),0) AS cursor FROM events WHERE stream_id=?",
    );
    statement.setReadBigInts(true);
    return (
      statement.get(command.streamId) as { cursor: bigint }
    ).cursor.toString();
  }
  if (command.op === "backup")
    throw new Error("Backup must run outside transaction");
  if (command.op === "event") {
    const stmt = db.prepare(
      "SELECT COALESCE(MAX(sequence),0)+1 AS n FROM events WHERE stream_id=?",
    );
    stmt.setReadBigInts(true);
    const row = stmt.get(command.event.streamId) as {
      n: bigint;
    };
    const event = EventSchema.parse({
      ...command.event,
      data: publicProjection(command.event.data),
      schemaVersion: 1,
      eventId: randomUUID(),
      sequence: row.n.toString(),
    });
    db.prepare(
      "INSERT INTO events(event_id,stream_id,sequence,payload) VALUES(?,?,?,?)",
    ).run(event.eventId, event.streamId, row.n, JSON.stringify(event));
    return event;
  }
  if (command.op === "events")
    return db
      .prepare(
        "SELECT payload FROM events WHERE stream_id=? AND sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(command.streamId, BigInt(command.after), command.limit)
      .map((r) => JSON.parse(r.payload as string));
  if (command.op === "unlock") {
    db.prepare(
      "DELETE FROM resource_locks WHERE json_extract(payload,'$.owner')=?",
    ).run(command.owner);
    return true;
  }
  if (command.op === "lock") {
    const rows = db
      .prepare(
        "SELECT payload FROM resource_locks WHERE json_extract(payload,'$.resourceId')=?",
      )
      .all(command.resourceId)
      .map(
        (r) =>
          JSON.parse(r.payload as string) as {
            owner: string;
            mode: string;
          },
      );
    const own = rows.find((r) => r.owner === command.owner);
    if (own) {
      if (own.mode !== command.mode) throw new Error("conflict");
      return true;
    }
    if (
      rows.some((r) => r.mode === "write") ||
      (command.mode === "write" && rows.length) ||
      (command.mode === "read" && rows.length >= command.maxReads)
    )
      throw new Error("conflict");
    const value = {
      id: `${command.owner}:${command.resourceId}`,
      revision: 1,
      resourceId: command.resourceId,
      owner: command.owner,
      mode: command.mode,
    };
    db.prepare("INSERT INTO resource_locks VALUES(?,?,?)").run(
      value.id,
      1,
      JSON.stringify(value),
    );
    return true;
  }
  assertTable(command.table);
  if (command.op === "get") {
    const row = db
      .prepare(`SELECT payload FROM ${command.table} WHERE id=?`)
      .get(command.id);
    return row ? JSON.parse(row.payload as string) : undefined;
  }
  if (command.op === "list")
    return db
      .prepare(`SELECT payload FROM ${command.table} ORDER BY rowid`)
      .all()
      .map((row) => JSON.parse(row.payload as string));
  const id = command.op === "put" ? command.value.id : command.id;
  const row = db
    .prepare(`SELECT revision FROM ${command.table} WHERE id=?`)
    .get(id);
  if (Number(row?.revision ?? 0) !== command.expectedRevision)
    throw new Error("conflict");
  if (command.op === "delete") {
    db.prepare(`DELETE FROM ${command.table} WHERE id=?`).run(id);
    return true;
  }
  if (command.value.revision !== command.expectedRevision + 1)
    throw new Error("conflict");
  db.prepare(
    `INSERT INTO ${command.table}(id,revision,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload`,
  ).run(id, command.value.revision, JSON.stringify(command.value));
  return command.value;
}
let queue = Promise.resolve();
parentPort!.on("message", (request: { id: number; commands: DbCommand[] }) => {
  queue = queue.then(async () => {
    try {
      if (
        request.commands.length === 1 &&
        request.commands[0]?.op === "backup"
      ) {
        await backup(db, request.commands[0].path);
        parentPort!.postMessage({ id: request.id, results: [true] });
        return;
      }
      db.exec("BEGIN IMMEDIATE");
      const results = request.commands.map(execute);
      db.exec("COMMIT");
      parentPort!.postMessage({ id: request.id, results });
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      parentPort!.postMessage({
        id: request.id,
        error:
          error instanceof Error && error.message === "conflict"
            ? "conflict"
            : "storage_error",
      });
    }
  });
});
