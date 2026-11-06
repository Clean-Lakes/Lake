import {
  lstatSync,
  realpathSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve, join, sep, isAbsolute } from "node:path";
import { createConnection } from "mysql2";
import { Client } from "pg";
import { createClient } from "@redis/client";
import type {
  Resource,
  ResourceTreeNode,
} from "../../web-agent/shared/contracts";
import { LakeStore, HttpError, id, now } from "./store";
import type { LakeSecurity } from "./security";
import { digest, text } from "./tasks";

const serviceKinds = [
  "database",
  "redis",
  "apisix",
  "prometheus",
  "victoriametrics",
];
const secretKeys = ["password", "token", "apiKey"] as const;
type Settings = Record<string, any>;
type Secrets = Partial<Record<(typeof secretKeys)[number], string>>;
const integer = (value: any, fallback: number, min: number, max: number) => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new HttpError(400, "端口或数据库编号无效");
  return n as number;
};
const field = (value: any, name: string, max = 256) => {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > max || /[\r\n\0]/.test(value))
    throw new HttpError(400, `${name}格式无效`);
  return value.trim();
};
export function isServiceKind(kind: string, settings?: Settings) {
  return (
    serviceKinds.includes(kind) &&
    (kind !== "database" || ["mysql", "postgres"].includes(settings?.driver))
  );
}

/** Items configuration is not a connectivity observation or an execution grant. */
export class LakeServiceResources {
  private probes = new Set<AbortController>();
  constructor(
    readonly store: LakeStore,
    readonly security: LakeSecurity,
    readonly registerSecret: (value: string) => void,
  ) {
    this.cleanupCredentials();
  }
  private cleanupCredentials() {
    try {
      for (const entry of this.store.list<{ ref: string }>(
        "serviceSecretCleanup",
      )) {
        if (!/^(?:service|mysql)-[a-f0-9-]+\.json$/.test(entry.ref)) continue;
        if (
          this.store
            .list<Resource>("resources")
            .some(
              (resource) =>
                resource.settings?.credentialRef === entry.ref ||
                resource.ssh?.credentialRef === entry.ref,
            ) ||
          this.store.list<string>("providerCredentialRefs").includes(entry.ref)
        )
          continue;
        try {
          unlinkSync(this.privateFile(entry.ref));
          this.store.delete("serviceSecretCleanup", entry.ref);
        } catch {
          try {
            lstatSync(join(this.store.home, "secrets", entry.ref));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              this.store.delete("serviceSecretCleanup", entry.ref);
          }
        }
      }
    } catch {
      /* Keep durable cleanup intents; never roll back a committed connection. */
    }
  }
  private privateFile(ref: string) {
    const root = join(this.store.home, "secrets"),
      path = isAbsolute(ref) ? ref : resolve(root, ref);
    try {
      const dir = lstatSync(root),
        file = lstatSync(path);
      if (
        dir.isSymbolicLink() ||
        !dir.isDirectory() ||
        dir.mode & 0o077 ||
        file.isSymbolicLink() ||
        !file.isFile() ||
        file.mode & 0o077 ||
        file.size > 65536 ||
        !path.startsWith(root + sep) ||
        !realpathSync(path).startsWith(realpathSync(root) + sep) ||
        (process.platform !== "win32" &&
          (dir.uid !== process.getuid?.() || file.uid !== process.getuid?.()))
      )
        throw new Error();
      return path;
    } catch {
      throw new HttpError(409, "资源凭据须为当前 Lake Home 内的私有文件");
    }
  }
  private readSecrets(ref?: unknown): Secrets {
    if (ref === undefined || ref === "") return {};
    if (typeof ref !== "string") throw new HttpError(409, "资源凭据引用无效");
    try {
      const value = JSON.parse(readFileSync(this.privateFile(ref), "utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some(
          (key) => ![...secretKeys, "username"].includes(key as any),
        )
      )
        throw new Error();
      const result: Secrets = {};
      for (const key of secretKeys)
        if (value[key] !== undefined) {
          if (
            typeof value[key] !== "string" ||
            value[key].length > 16384 ||
            /[\r\n\0]/.test(value[key])
          )
            throw new Error();
          result[key] = value[key];
          this.registerSecret(value[key]);
        }
      return result;
    } catch {
      throw new HttpError(409, "资源凭据不可用，请重新填写");
    }
  }
  private parse(kind: string, input: Settings, previous?: Settings) {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      JSON.stringify(input).length > 65536
    )
      throw new HttpError(400, "资源配置无效");
    const allowed =
      kind === "database"
        ? ["driver", "host", "port", "username", "database", "tls", "sslmode"]
        : kind === "redis"
          ? ["host", "port", "username", "db", "tls"]
          : kind === "apisix"
            ? ["endpoint"]
            : ["endpoint", "username", "authMethod"];
    if (
      !serviceKinds.includes(kind) ||
      Object.keys(input).some(
        (key) =>
          ![
            ...allowed,
            ...secretKeys,
            "credentialRef",
            "clearCredential",
          ].includes(key),
      )
    )
      throw new HttpError(400, "不支持的资源配置字段");
    if (
      input.credentialRef !== undefined &&
      (!previous?.credentialRef ||
        input.credentialRef !== previous.credentialRef)
    )
      throw new HttpError(400, "请填写凭据，不接受其他资源的凭据引用");
    if (
      input.clearCredential !== undefined &&
      typeof input.clearCredential !== "boolean"
    )
      throw new HttpError(400, "清除凭据选项无效");
    const value = { ...previous, ...input },
      config: Settings = {};
    if (kind === "database") {
      if (
        !["mysql", "postgres"].includes(value.driver) ||
        (previous?.driver && value.driver !== previous.driver)
      )
        throw new HttpError(400, "数据库类型无效，不能更换已有资源的类型");
      config.driver = value.driver;
    }
    if (kind === "database" || kind === "redis") {
      config.host = field(value.host, "主机地址", 253);
      if (!config.host || !/^\[?[a-zA-Z0-9_:.-]+\]?$/.test(config.host))
        throw new HttpError(400, "请填写有效的主机名或 IP");
      config.port = integer(
        value.port,
        kind === "redis" ? 6379 : value.driver === "mysql" ? 3306 : 5432,
        1,
        65535,
      );
      config.username = field(value.username, "用户名");
      if (kind === "database" && !config.username)
        throw new HttpError(400, "请填写数据库用户名");
      if (value.tls !== undefined && typeof value.tls !== "boolean")
        throw new HttpError(400, "TLS 配置无效");
      config.tls = value.tls ?? kind !== "redis";
      if (kind === "redis") config.db = integer(value.db, 0, 0, 65535);
      else {
        config.database = field(value.database, "数据库名称");
        config.sslmode = config.tls ? "verify-full" : "disable";
        if (input.sslmode !== undefined && input.sslmode !== config.sslmode)
          throw new HttpError(400, "TLS 配置与证书验证方式不一致");
      }
    } else {
      const endpoint = field(value.endpoint, "端点", 2048);
      let url: URL;
      try {
        url = new URL(endpoint);
      } catch {
        throw new HttpError(400, "请填写有效的 HTTP(S) 端点");
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        /[?#\\\s]/.test(endpoint) ||
        (url.port && (!Number(url.port) || Number(url.port) > 65535))
      )
        throw new HttpError(400, "端点不能包含凭据、查询参数或片段");
      config.endpoint = url.href.replace(/\/$/, "");
      if (kind !== "apisix") config.username = field(value.username, "用户名");
    }
    let secrets = input.clearCredential
      ? {}
      : this.readSecrets(previous?.credentialRef);
    for (const key of secretKeys)
      if (input[key] !== undefined) {
        if (
          typeof input[key] !== "string" ||
          input[key].length > 16384 ||
          /[\r\n\0]/.test(input[key])
        )
          throw new HttpError(400, "凭据格式无效");
        if (input[key]) secrets = { ...secrets, [key]: input[key] };
      }
    if (["prometheus", "victoriametrics"].includes(kind)) {
      config.authMethod =
        value.authMethod ??
        (secrets.token ? "bearer" : config.username ? "basic" : "none");
      if (!["none", "basic", "bearer"].includes(config.authMethod))
        throw new HttpError(400, "不支持的认证方式");
      if (config.authMethod === "none") {
        if (input.password || input.token || config.username)
          throw new HttpError(400, "无需认证时不能提供认证信息");
        secrets = {};
      }
      if (
        (config.authMethod === "basic" && !config.username) ||
        (config.authMethod === "bearer" && !secrets.token)
      )
        throw new HttpError(400, "请填写完整的认证信息");
    }
    const allowedSecrets =
      kind === "apisix"
        ? ["apiKey"]
        : ["prometheus", "victoriametrics"].includes(kind)
          ? ["password", "token"]
          : ["password"];
    if (
      Object.keys(secrets).some((key) => !allowedSecrets.includes(key)) ||
      (secrets.password && secrets.token) ||
      (secrets.token && config.username) ||
      (secrets.password && !config.username && kind !== "redis")
    )
      throw new HttpError(400, "认证方式不一致，请清除旧凭据后重新填写");
    // Reject nonempty credential fields that do not belong to this type, even
    // when no file was created. Empty unrelated UI fields remain harmless.
    if (secretKeys.some((key) => input[key] && !allowedSecrets.includes(key)))
      throw new HttpError(400, "该资源不支持此凭据类型");
    for (const value of Object.values(secrets)) this.registerSecret(value!);
    return { config, secrets };
  }
  prepare(kind: string, input: Settings, previous?: Settings) {
    const { config, secrets } = this.parse(kind, input, previous);
    let created: string | undefined;
    if (Object.keys(secrets).length) {
      if (
        previous?.credentialRef &&
        !input.clearCredential &&
        digest(secrets) === digest(this.readSecrets(previous.credentialRef))
      )
        config.credentialRef = previous.credentialRef;
      else {
        const root = join(this.store.home, "secrets");
        mkdirSync(root, { recursive: true, mode: 0o700 });
        const dir = lstatSync(root);
        if (
          dir.isSymbolicLink() ||
          !dir.isDirectory() ||
          dir.mode & 0o077 ||
          (process.platform !== "win32" && dir.uid !== process.getuid?.())
        )
          throw new HttpError(409, "Lake 凭据目录权限无效");
        const ref = "service-" + id() + ".json";
        created = join(root, ref);
        writeFileSync(created, JSON.stringify(secrets), {
          mode: 0o600,
          flag: "wx",
        });
        config.credentialRef = ref;
      }
    }
    return {
      settings: config,
      rollback: () => {
        if (created) {
          unlinkSync(created);
          created = undefined;
        }
      },
    };
  }
  create(projectId: string, input: any) {
    this.security.resource(projectId);
    this.store.project(projectId);
    const name = text(input.name, "资源名称", 160).trim();
    if (!name) throw new HttpError(400, "请填写资源名称");
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      let cursor: string | null = text(parentId, "parentId", 128);
      const seen = new Set<string>();
      while (cursor) {
        const parent: ResourceTreeNode | undefined = this.store.get(
          "tree",
          cursor,
        );
        if (
          seen.has(cursor) ||
          !parent ||
          parent.projectId !== projectId ||
          parent.kind !== "folder"
        )
          throw new HttpError(400, "目标目录不属于当前项目或目录层级无效");
        seen.add(cursor);
        cursor = parent.parentId;
      }
    }
    const prepared = this.prepare(input.kind, input.settings);
    try {
      return this.store.transaction(() => {
        const resource: Resource = {
          id: id(),
          projectId,
          name,
          kind: input.kind,
          description: "",
          status: "available",
          settings: prepared.settings,
          configurationRevision: 1,
        };
        const siblings = this.store
          .list<ResourceTreeNode>("tree")
          .filter((n) => n.projectId === projectId && n.parentId === parentId);
        this.store.put("resources", resource.id, resource);
        this.store.put("resourceRevisions", resource.id, 1);
        this.store.put("tree", resource.id, {
          id: resource.id,
          projectId,
          parentId,
          resourceId: resource.id,
          name,
          kind: "resource",
          position:
            Math.max(
              -1,
              ...siblings.map((n) => n.position).filter(Number.isFinite),
            ) + 1,
        });
        return resource;
      });
    } catch (error) {
      prepared.rollback();
      throw error;
    }
  }
  update(resource: Resource, input: any) {
    this.security.resource(resource.projectId);
    const prepared = input.settings
      ? this.prepare(resource.kind, input.settings, resource.settings)
      : undefined;
    try {
      const result = this.store.transaction(() => {
        const next = {
          ...resource,
          name:
            input.name === undefined
              ? resource.name
              : text(input.name, "资源名称", 160).trim(),
          settings: prepared?.settings ?? resource.settings,
        };
        if (!next.name) throw new HttpError(400, "请填写资源名称");
        if (prepared && digest(next.settings) !== digest(resource.settings))
          this.store.put(
            "resourceRevisions",
            resource.id,
            (this.store.get<number>("resourceRevisions", resource.id) ?? 1) + 1,
          );
        next.configurationRevision =
          this.store.get<number>("resourceRevisions", resource.id) ?? 1;
        this.store.put("resources", resource.id, next);
        const oldRef = resource.settings?.credentialRef;
        if (
          typeof oldRef === "string" &&
          oldRef !== next.settings?.credentialRef &&
          /^(?:service|mysql)-[a-f0-9-]+\.json$/.test(oldRef)
        )
          this.store.put("serviceSecretCleanup", oldRef, { ref: oldRef });
        for (const node of this.store.list<ResourceTreeNode>("tree"))
          if (node.resourceId === resource.id)
            this.store.put("tree", node.id, { ...node, name: next.name });
        return next;
      });
      this.cleanupCredentials();
      return result;
    } catch (error) {
      prepared?.rollback();
      throw error;
    }
  }
  async test(projectId: string, input: any, signal?: AbortSignal) {
    this.security.resource(projectId);
    this.store.project(projectId);
    const saved = input.resourceId
      ? this.store.require<Resource>(
          "resources",
          text(input.resourceId, "resourceId", 128),
        )
      : undefined;
    if (saved && (saved.projectId !== projectId || saved.kind !== input.kind))
      throw new HttpError(404, "当前项目中未找到此资源");
    const credentialState = saved
      ? digest(this.readSecrets(saved.settings?.credentialRef))
      : undefined;
    const revision = saved
      ? (this.store.get<number>("resourceRevisions", saved.id) ?? 1)
      : undefined;
    if (saved && input.revision !== revision)
      throw new HttpError(409, "资源配置已变化，请刷新后测试");
    const { config, secrets } = this.parse(
        input.kind,
        input.settings ?? {},
        saved?.settings,
      ),
      controller = new AbortController();
    if (this.probes.size >= 4)
      throw new HttpError(429, "连接测试进行中，请稍后重试");
    this.probes.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(abort, 8000),
      guard = setInterval(() => {
        try {
          this.security.resource(projectId);
        } catch {
          abort();
        }
      }, 200);
    let close = () => {};
    try {
      controller.signal.throwIfAborted();
      const stop = new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => {
            close();
            reject(new HttpError(408, "连接测试已取消或超时"));
          },
          { once: true },
        ),
      );
      await Promise.race([
        stop,
        (async () => {
          const host = String(config.host ?? "").replace(/^\[|\]$/g, "");
          if (input.kind === "database" && config.driver === "mysql") {
            const connection = createConnection({
              host,
              port: config.port,
              user: config.username,
              password: secrets.password ?? "",
              database: config.database || undefined,
              ssl: config.tls ? { rejectUnauthorized: true } : undefined,
              connectTimeout: 5000,
              multipleStatements: false,
            });
            connection.on("error", () => {});
            close = () => connection.destroy();
            await new Promise<void>((ok, fail) =>
              connection.query(
                { sql: "SELECT 1 AS lake_connection_test", timeout: 5000 },
                (error) => (error ? fail(error) : ok()),
              ),
            );
          } else if (input.kind === "database") {
            const client = new Client({
              host,
              port: config.port,
              user: config.username,
              password: async () => secrets.password ?? "",
              database: config.database || config.username,
              ssl: config.tls ? { rejectUnauthorized: true } : false,
              connectionTimeoutMillis: 5000,
              query_timeout: 5000,
              statement_timeout: 5000,
              application_name: "Lake connection test",
              options: "-c default_transaction_read_only=on",
              fallback_application_name: "Lake",
            });
            client.on("error", () => {});
            close = () => {
              void client.end().catch(() => {});
            };
            await client.connect();
            await client.query("SELECT 1 AS lake_connection_test");
          } else if (input.kind === "redis") {
            const client = createClient({
              socket: {
                host,
                port: config.port,
                connectTimeout: 5000,
                reconnectStrategy: false,
                ...(config.tls
                  ? { tls: true as const, rejectUnauthorized: true }
                  : {}),
              },
              username: config.username || undefined,
              password: secrets.password,
              database: config.db,
              disableOfflineQueue: true,
              disableClientInfo: true,
            });
            client.on("error", () => {});
            close = () => {
              if (client.isOpen) client.destroy();
            };
            await client.connect();
            if ((await client.ping()) !== "PONG") throw new Error();
          } else
            await this.testHTTP(input.kind, config, secrets, controller.signal);
        })(),
      ]);
      this.security.resource(projectId);
      if (saved) {
        const current = this.store.get<Resource>("resources", saved.id);
        if (
          !current ||
          digest(current.settings) !== digest(saved.settings) ||
          digest(this.readSecrets(current.settings?.credentialRef)) !==
            credentialState ||
          (this.store.get<number>("resourceRevisions", saved.id) ?? 1) !==
            revision
        )
          throw new HttpError(409, "资源配置已变化，请刷新后测试");
      }
      return {
        message: "连接和认证检查通过；这不代表业务服务整体健康。",
        protocol: input.kind === "database" ? config.driver : input.kind,
        testedAt: now(),
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const code = String((error as any)?.code ?? "");
      const message = /AUTH|ACCESS_DENIED|28P01|WRONGPASS|NOAUTH/.test(code)
        ? "认证失败，请检查账号或凭据"
        : /CERT|TLS|SSL/.test(code)
          ? "TLS 证书验证失败，请检查证书和主机名"
          : /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(code)
            ? "无法连接，请检查地址、端口和网络"
            : "连接测试失败，请检查连接配置、认证和服务状态";
      throw new HttpError(502, message);
    } finally {
      clearTimeout(timeout);
      clearInterval(guard);
      signal?.removeEventListener("abort", abort);
      this.probes.delete(controller);
      close();
    }
  }
  close() {
    for (const probe of this.probes) probe.abort();
  }
  private async testHTTP(
    kind: string,
    config: Settings,
    secrets: Secrets,
    signal: AbortSignal,
  ) {
    const suffix = kind === "apisix" ? "plugins/list" : "query";
    let endpoint = config.endpoint;
    if (kind === "apisix" && !endpoint.endsWith("/apisix/admin"))
      endpoint += "/apisix/admin";
    if (kind !== "apisix" && !endpoint.endsWith("/api/v1"))
      endpoint += "/api/v1";
    const url = new URL(endpoint + "/" + suffix);
    if (kind !== "apisix") url.searchParams.set("query", "1");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (kind === "apisix" && secrets.apiKey)
      headers["X-API-KEY"] = secrets.apiKey;
    else if (secrets.token) headers.Authorization = "Bearer " + secrets.token;
    else if (config.username)
      headers.Authorization =
        "Basic " +
        Buffer.from(config.username + ":" + (secrets.password ?? "")).toString(
          "base64",
        );
    const response = await fetch(url, { signal, headers, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new HttpError(502, "测试地址发生重定向，请填写准确服务地址后重试");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(
        502,
        response.status === 401 || response.status === 403
          ? "认证失败或没有读取权限"
          : `服务未通过连接检查（HTTP ${response.status}）`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new HttpError(502, "服务返回为空");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.byteLength;
      if (size > 262144) {
        await reader.cancel();
        throw new HttpError(502, "连接测试响应过大");
      }
      chunks.push(value.value);
    }
    let value: any;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(502, "服务未返回有效的协议响应");
    }
    const sample = (value: any) =>
      Array.isArray(value) &&
      value.length === 2 &&
      Number.isFinite(Number(value[0])) &&
      typeof value[1] === "string" &&
      Number(value[1]) === 1;
    const metricResult = value?.data?.result;
    const validMetric =
      value?.status === "success" &&
      (value?.data?.resultType === "scalar"
        ? sample(metricResult)
        : value?.data?.resultType === "vector" &&
          Array.isArray(metricResult) &&
          metricResult.length === 1 &&
          sample(metricResult[0]?.value));
    if (
      kind === "apisix"
        ? !Array.isArray(value) ||
          !value.every((v: any) => typeof v === "string")
        : !validMetric
    )
      throw new HttpError(502, "返回内容与所选服务类型不符");
  }
}
