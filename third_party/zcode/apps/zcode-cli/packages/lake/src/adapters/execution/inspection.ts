import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import mysql from "mysql2";
import type { JsonValue } from "../../domain/json.js";
import { inspectionSQL, kubeArgs } from "../../domain/inspection.js";
import { integer, object, redact, text, type Params } from "../../domain/validation.js";
import { FileVault } from "../vault.js";
import { runProcess } from "./process.js";

const environment = (): NodeJS.ProcessEnv => Object.fromEntries(["PATH", "HOME", "USER", "LANG", "TMPDIR", "SYSTEMROOT"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
export class InspectionTransport {
  constructor(private readonly vault: FileVault) {}
  async request(method: string, p: Params, signal: AbortSignal): Promise<JsonValue> {
    const resource = object(p.resource), ref = text(p, "credential_ref"), start = Date.now();
    if (method === "transport.k8s") {
      if (!ref.startsWith("file:kubeconfig/")) throw new Error("需要已迁移的 kubeconfig");
      const args = kubeArgs(p, object(resource.k8s)), config = await this.vault.loadReference(ref);
      let directory = "";
      try {
        directory = await mkdtemp(join(tmpdir(), "lake-kube-")); await chmod(directory, 0o700);
        const file = join(directory, "config"); await writeFile(file, config, { mode: 0o600, flag: "wx" });
        const result = await runProcess("kubectl", ["--kubeconfig", file, ...args], { signal, timeoutMS: 30_000, env: environment() });
        // Config and diagnostic messages may contain credentials. Only successful get output is returned.
        return { ...result, stderr: "", error: result.status === "completed" ? "" : "Kubernetes 查询失败或中断", resource: `${resource.lake}/${resource.name}`, kind: text(p, "kind"), output: result.status === "completed" ? redact(String(result.stdout), 65_536) : "", stdout: "" };
      } finally { config.fill(0); if (directory) await rm(directory, { recursive: true, force: true }); }
    }
    if (method !== "transport.database") throw new Error("未知的检查传输");
    const spec = object(resource.db), kind = text(resource, "kind"), check = text(p, "check"), sql = inspectionSQL(kind, check, text(spec, "database"));
    if (ref && !ref.startsWith("file:database/")) throw new Error("需要已迁移的数据库凭据");
    const password = ref ? await this.vault.loadReference(ref) : Buffer.alloc(0);
    let close = (): void => {}, rejectQuery: ((error: Error) => void) | undefined, stopped = false;
    const wait = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => { rejectQuery = reject; operation.then(resolve, reject); if (stopped) reject(new Error("查询已结束")); });
    const stop = () => { stopped = true; close(); rejectQuery?.(new Error("查询已取消或超时")); };
    const timeout = setTimeout(stop, 15_000); signal.addEventListener("abort", stop, { once: true });
    try {
      signal.throwIfAborted();
      const ssl = text(spec, "tls_mode", "verify") === "verify" ? { rejectUnauthorized: true } : undefined;
      let columns: string[], values: unknown[][], truncated = false;
      if (kind === "postgres") {
        const client = new pg.Client({ host: text(spec, "host"), port: integer(spec, "port", 5432), user: text(spec, "username"), password: password.toString("utf8"), database: text(spec, "database", text(spec, "username")), ssl: ssl ?? false, connectionTimeoutMillis: 5000, query_timeout: 15_000, application_name: "lake" });
        client.on("error", () => {}); close = () => { void client.end().catch(() => {}); };
        await wait(client.connect()); signal.throwIfAborted();
        const result = await wait(client.query({ text: sql, rowMode: "array" }));
        columns = result.fields.map(field => field.name); values = result.rows as unknown[][]; truncated = values.length > 200;
        await client.end();
      } else {
        const client = mysql.createConnection({ host: text(spec, "host"), port: integer(spec, "port", 3306), user: text(spec, "username"), password: password.toString("utf8"), database: text(spec, "database") || undefined, ssl, connectTimeout: 5000, multipleStatements: false, rowsAsArray: true });
        client.on("error", () => {}); close = () => client.destroy();
        columns = []; values = [];
        await new Promise<void>((resolve, reject) => {
          const query = client.query({ sql, timeout: 15_000, rowsAsArray: true });
          rejectQuery = reject;
          query.on("fields", fields => { columns = (Array.isArray(fields) ? fields : [fields]).map(field => field.name); });
          query.on("result", row => { if (values.length < 200) values.push(row as unknown[]); else { truncated = true; client.destroy(); resolve(); } });
          query.on("error", reject); query.on("end", resolve);
          client.once("close", () => { if (!truncated) reject(new Error("数据库连接已关闭")); });
        });
      }
      signal.throwIfAborted(); if (stopped) throw new Error("查询已超时");
      const secret = password.toString("utf8"), clean = (value: unknown) => redact((value === null ? "" : String(value)).split(secret || "\u0000").join(secret ? "[REDACTED]" : "\u0000"), 512);
      return { resource: `${resource.lake}/${resource.name}`, check, columns: columns.map(clean), rows: values.slice(0, 200).map(row => row.map(clean)), truncated, status: "completed", duration_ms: Date.now() - start, exit_code: 0, stdout: "", stderr: "", error: "" };
    } catch { return { status: signal.aborted || stopped ? "unknown" : "failed", error: "数据库连接或固定查询失败", duration_ms: Date.now() - start, exit_code: -1, stdout: "", stderr: "" }; }
    finally { clearTimeout(timeout); signal.removeEventListener("abort", stop); close(); password.fill(0); }
  }
}
