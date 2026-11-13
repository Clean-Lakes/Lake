import {redactModelValue} from "./model-errors";
import { boundResourceRevision } from "./resource-pin";
import { createConnection, type Connection, type FieldPacket } from "mysql2";
import { createConnection as socketConnection } from "node:net";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { Resource } from "../../web-agent/shared/contracts";
import { HttpError, LakeStore, now, id } from "./store";
import type { LakeSecurity } from "./security";
import { digest, text } from "./tasks";

type Config = {
  driver: "mysql";
  host: string;
  port: number;
  username: string;
  database?: string;
  credentialRef?: string;
  tls: boolean;
};
export type DatabaseScope = {
  database: string;
  schema: string;
  maxRows: number;
  maxDurationMS: number;
};
export type MySQLInput = {
  asset_ref: string;
  configuration_revision: string;
  db?: string;
  schema?: string;
  query_type?: string;
  table?: string;
  columns?: string[];
  order_by?: string[];
  limit?: number;
  offset?: number;
  mode?: "rows" | "count";
};
const identifier = (v: unknown, name: string) => text(v, name, 256);
const quote = (v: string) => "`" + v.replaceAll("`", "``") + "`";
const integer = (v: unknown, fallback: number, max: number) => {
  const n = v ?? fallback;
  if (!Number.isSafeInteger(n) || Number(n) < 0 || Number(n) > max)
    throw new HttpError(400, "MySQL 读取数量或偏移无效");
  return Number(n);
};
const byteLimit = 512 * 1024,
  resultLimit = 96 * 1024;

/** Fixed queries only. No model SQL, connection strings, credential values or Shell. */
export class LakeMySQL {
  private connections = new Map<Connection, () => void>();
  constructor(
    readonly store: LakeStore,
    readonly security: LakeSecurity,
    readonly registerSecret: (value: string) => void,
    readonly redact: (value: string) => string,
  ) {}
  private credentialPath(ref: string) {
    const root = join(this.store.home, "secrets"),
      path = isAbsolute(ref) ? ref : resolve(root, ref),
      parent = lstatSync(root),
      info = lstatSync(path);
    if (
      parent.isSymbolicLink() ||
      !parent.isDirectory() ||
      parent.mode & 0o077 ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      info.size > 16384 ||
      !(
        path.startsWith(root + sep) &&
        realpathSync(path).startsWith(realpathSync(root) + sep)
      ) ||
      (process.platform !== "win32" &&
        (parent.uid !== process.getuid?.() || info.uid !== process.getuid?.()))
    )
      throw new HttpError(409, "MySQL 凭据须为当前 Dev Home 内的私有文件");
    return path;
  }
  configuration(input: any): Config {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            "driver",
            "host",
            "port",
            "username",
            "database",
            "credentialRef",
            "tls",
            "sslmode",
          ].includes(key),
      ) ||
      input.driver !== "mysql"
    )
      throw new HttpError(400, "此读取适配只支持已保存的 MySQL 配置");
    const host = text(input.host, "host", 253),
      port = integer(input.port, 3306, 65535),
      username = text(input.username, "username", 128);
    if (
      !port ||
      !/^\[?[a-zA-Z0-9_:.-]+\]?$/.test(host) ||
      (input.tls !== undefined && typeof input.tls !== "boolean")
    )
      throw new HttpError(400, "MySQL 地址、端口或 TLS 配置无效");
    // The shared MySQL/PostgreSQL form also sends sslmode. Only accept its
    // exact TLS equivalent; it cannot override certificate verification.
    if (
      input.sslmode !== undefined &&
      input.sslmode !== (input.tls === false ? "disable" : "verify-full")
    )
      throw new HttpError(400, "MySQL sslmode 与 TLS 配置不一致");
    const config: Config = {
      driver: "mysql",
      host,
      port,
      username,
      tls: input.tls !== false,
    };
    if (input.database)
      config.database = identifier(input.database, "database");
    if (input.credentialRef) {
      config.credentialRef = text(input.credentialRef, "credentialRef", 1024);
      this.credentialPath(config.credentialRef);
    }
    return config;
  }
  prepare(input: any, previous?: Record<string, unknown>) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new HttpError(400, "MySQL 配置无效");
    const value = { ...previous, ...input };
    let path: string | undefined;
    if (input.password !== undefined) {
      if (
        typeof input.password !== "string" ||
        input.password.length > 8192 ||
        /[\r\n\0]/.test(input.password)
      )
        throw new HttpError(400, "MySQL 密码格式无效");
      if (input.password) {
        if (input.credentialRef)
          throw new HttpError(400, "请只提供一种 MySQL 凭据来源");
        const root = join(this.store.home, "secrets");
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const info = lstatSync(root);
        if (
          info.isSymbolicLink() ||
          !info.isDirectory() ||
          info.mode & 0o077 ||
          (process.platform !== "win32" && info.uid !== process.getuid?.())
        )
          throw new HttpError(409, "Dev 凭据目录权限无效");
        const ref = "mysql-" + id() + ".json";
        path = join(root, ref);
        writeFileSync(path, JSON.stringify({ password: input.password }), {
          mode: 0o600,
          flag: "wx",
        });
        value.credentialRef = ref;
        this.registerSecret(input.password);
      }
      delete value.password;
    }
    try {
      return this.configuration(value);
    } catch (error) {
      if (path) unlinkSync(path);
      throw error;
    }
  }
  private credentials(config: Config) {
    if (!config.credentialRef)
      return { username: config.username, password: "" };
    const raw = readFileSync(this.credentialPath(config.credentialRef), "utf8");
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new HttpError(409, "MySQL 凭据格式需核实");
    }
    if (
      !data ||
      typeof data.password !== "string" ||
      data.password.length > 8192 ||
      /[\r\n\0]/.test(data.password) ||
      (data.username !== undefined && typeof data.username !== "string")
    )
      throw new HttpError(409, "MySQL 凭据字段无效");
    this.registerSecret(data.password);
    return {
      username: data.username || config.username,
      password: data.password,
    };
  }
  revision(resource: Resource) {
    if (resource.kind !== "database" || !resource.settings)
      throw new HttpError(409, "MySQL 连接配置不可用");
    const config = this.configuration(resource.settings),
      credentials = this.credentials(config);
    return digest([resource.id, resource.projectId, config, credentials]);
  }
  plan(resource: Resource, name: string, input: MySQLInput) {
    const config = this.configuration(resource.settings),
      schema = input.schema || input.db || config.database || "";
    if (input.schema && input.db && input.schema !== input.db)
      throw new HttpError(400, "MySQL db 与 schema 必须一致");
    if (schema) identifier(schema, "schema");
    const scope: DatabaseScope = {
      database: schema || config.database || "information_schema",
      schema: schema || "information_schema",
      maxRows:
        name === "list_db_objects"
          ? 1000
          : name === "db_table_ddl" || input.mode === "count"
            ? 1
            : integer(input.limit, 100, 500),
      maxDurationMS: 5000,
    };
    if (!scope.maxRows) throw new HttpError(400, "MySQL limit 必须大于零");
    const policy = this.security.database(
      resource.projectId,
      resource.id,
      scope,
    );
    const limit = policy.maxRows,
      parameters: unknown[] = [];
    let sql = "";
    if (name === "list_db_objects") {
      const kind = input.query_type ?? (schema ? "table" : "database");
      if (!["database", "schema", "table", "view", "object"].includes(kind))
        throw new HttpError(
          400,
          "query_type 仅支持 database/schema/table/view/object",
        );
      if (kind === "database" || kind === "schema") {
        if (schema) {
          sql =
            "SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name=? ORDER BY schema_name LIMIT ?";
          parameters.push(schema, limit + 1);
        } else {
          sql =
            "SELECT schema_name AS name FROM information_schema.schemata ORDER BY schema_name LIMIT ?";
          parameters.push(limit + 1);
        }
      } else {
        if (!schema)
          throw new HttpError(400, "请先指定已发现的 MySQL db/schema");
        sql =
          "SELECT table_name AS name,table_type AS type FROM information_schema.tables WHERE table_schema=?" +
          (kind === "table"
            ? " AND table_type='BASE TABLE'"
            : kind === "view"
              ? " AND table_type='VIEW'"
              : "") +
          " ORDER BY table_name LIMIT ?";
        parameters.push(schema, limit + 1);
      }
    } else {
      if (!schema) throw new HttpError(400, "请指定准确的 MySQL db/schema");
      const table = identifier(input.table, "table");
      if (name === "db_table_ddl")
        sql = `SHOW CREATE TABLE ${quote(schema)}.${quote(table)}`;
      else if (name === "read_db_table") {
        if (input.mode !== undefined && !["rows", "count"].includes(input.mode))
          throw new HttpError(400, "MySQL mode 仅支持 rows/count");
        const columns = (values: unknown) => {
          if (values === undefined) return [];
          if (!Array.isArray(values) || values.length > 64)
            throw new HttpError(400, "MySQL 列列表无效");
          return values.map((v) => identifier(v, "column"));
        };
        const names = columns(input.columns),
          order = columns(input.order_by);
        const offset = integer(input.offset, 0, 1000000);
        if (input.mode === "count")
          sql = `SELECT COUNT(*) AS row_count FROM ${quote(schema)}.${quote(table)}`;
        else {
          sql = `SELECT ${names.length ? names.map(quote).join(",") : "*"} FROM ${quote(schema)}.${quote(table)}${order.length ? " ORDER BY " + order.map(quote).join(",") : ""} LIMIT ? OFFSET ?`;
          parameters.push(limit + 1, offset);
        }
      } else throw new HttpError(400, "未注册的 MySQL 读取工具");
    }
    return {
      config,
      scope: { ...scope, maxRows: limit, maxDurationMS: policy.maxDurationMS },
      policy: policy.decision,
      sql,
      parameters,
      schema,
      provenReadOnly: name !== "read_db_table",
    };
  }
  async read(
    projectId: string,
    resource: Resource,
    name: string,
    input: MySQLInput,
    signal: AbortSignal,
    guard: () => void,
  ) {
    if (resource.projectId !== projectId || resource.status !== "available")
      throw new HttpError(403, "MySQL 资源不属于当前项目或配置不可用");
    const revision = this.revision(resource);
    if (!boundResourceRevision(this.store,resource,input.configuration_revision,revision))
      throw new HttpError(409, "MySQL 配置或凭据已变化，请重新读取资源目录");
    const plan = this.plan(resource, name, input),
      credentials = this.credentials(plan.config);
    const validate = () => {
      guard();
      const current = this.security.database(
        projectId,
        resource.id,
        plan.scope,
      );
      if (
        current.maxRows !== plan.scope.maxRows ||
        current.maxDurationMS !== plan.scope.maxDurationMS ||
        signal.aborted ||
        this.revision(this.store.require("resources", resource.id)) !== revision
      )
        throw new HttpError(409, "MySQL 读取已取消或连接/范围发生变化");
    };
    validate();
    const socket = socketConnection({
      host: plan.config.host,
      port: plan.config.port,
    });
    let bytes = 0,
      failure: Error | undefined,
      connection: Connection | undefined,
      rejectStop: (error: Error) => void;
    const interrupted = new Promise<never>((_, reject) => {
      rejectStop = reject;
    });
    void interrupted.catch(() => {});
    let activeStream: import("node:stream").Readable | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      rejectStop(failure);
      activeStream?.destroy(failure);
      connection?.destroy();
      socket.destroy(failure);
    };
    const wait = <T>(promise: Promise<T>) =>
      Promise.race([promise, interrupted]);
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > byteLimit) {
        stop(new HttpError(413, "MySQL 返回超过网络字节上限"));
      }
    });
    connection = createConnection({
      host: plan.config.host,
      port: plan.config.port,
      user: credentials.username,
      password: credentials.password,
      stream: socket,
      ssl: plan.config.tls ? { rejectUnauthorized: true } : undefined,
      connectTimeout: plan.scope.maxDurationMS,
      multipleStatements: false,
      flags: ["-LOCAL_FILES"],
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      rowsAsArray: true,
      disableEval: true,
    });
    const client = connection;
    this.connections.set(client, () =>
      stop(new HttpError(409, "MySQL 读取随内核退出而取消")),
    );
    client.on("error", () => {});
    const abort = () => stop(new HttpError(409, "MySQL 读取已取消"));
    const timer = setTimeout(
      () => stop(new HttpError(504, "MySQL 读取超时，原操作记录保留")),
      plan.scope.maxDurationMS,
    );
    signal.addEventListener("abort", abort, { once: true });
    const query = (sql: string, values: unknown[] = []) =>
      wait(
        new Promise<void>((ok, fail) => {
          validate();
          client.query(sql, values, (error) => (error ? fail(error) : ok()));
        }),
      );
    try {
      await wait(
        new Promise<void>((ok, fail) =>
          client.connect((error) => (error ? fail(error) : ok())),
        ),
      );
      validate();
      await query("SET SESSION MAX_EXECUTION_TIME=" + plan.scope.maxDurationMS);
      await query("START TRANSACTION READ ONLY");
      const result = await wait(
        new Promise<{ columns: string[]; rows: unknown[][] }>((ok, fail) => {
          validate();
          const rows: unknown[][] = [];
          let columns: string[] = [],
            size = 0;
          const request = client.query({ sql: plan.sql }, plan.parameters);
          request.on("fields", (fields: FieldPacket[]) => {
            columns = fields.map((f) => f.name);
            size += Buffer.byteLength(JSON.stringify(columns));
            if (size > resultLimit)
              stop(new HttpError(413, "MySQL 结果超过读取预算"));
          });
          const stream = request.stream({ highWaterMark: 8 });
          activeStream = stream;
          stream.on("data", (row: unknown[]) => {
            try {
              validate();
              size += Buffer.byteLength(JSON.stringify(row));
              if (size > resultLimit || rows.length > plan.scope.maxRows)
                throw new HttpError(413, "MySQL 结果超过读取预算");
              rows.push(row);
            } catch (error) {
              stop(error as Error);
            }
          });
          stream.once("error", fail);
          stream.once("end", () => ok({ columns, rows }));
        }),
      );
      activeStream = undefined;
      validate();
      await query("ROLLBACK");
      validate();
      const truncated = result.rows.length > plan.scope.maxRows;
      const output = {
        asset_ref: resource.id,
        configuration_revision: revision,
        observedAt: now(),
        schema: plan.schema,
        columns: result.columns,
        rows: result.rows.slice(0, plan.scope.maxRows),
        truncated,
        ...(name === "read_db_table" && input.mode !== "count"
          ? {
              nextOffset: truncated
                ? (input.offset ?? 0) + plan.scope.maxRows
                : null,
              ordered: !!input.order_by?.length,
            }
          : {}),
        notice:
          "Bounded observation from one read-only transaction; not a cross-server consistency proof.",
      };
      return redactModelValue(output,text=>this.redact(text));
    } catch (error) {
      if (failure) throw failure;
      if (error instanceof HttpError) throw error;
      const code = String((error as any)?.code ?? "");
      throw new HttpError(
        502,
        "MySQL 读取失败" +
          (/^[A-Z0-9_]{1,64}$/.test(code) ? "（" + code + "）" : ""),
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.connections.delete(client);
      client.destroy();
      socket.destroy();
    }
  }
  close() {
    for (const stop of this.connections.values()) stop();
    this.connections.clear();
  }
}
