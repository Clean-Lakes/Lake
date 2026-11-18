import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createSecureContext, checkServerIdentity } from "node:tls";
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { isAlias, parseDocument, visit } from "yaml";
import { HttpError } from "./store";

export const kubeconfigLimit = 1024 * 1024;
type Settings = Record<string, any>;
type Secrets = { token?: string; kubeconfig?: string };
type Connection = {
  metadata: Settings;
  token: string;
  username: string;
  password: string;
  ca?: string;
  cert?: string;
  key?: string;
  serverName: string;
  verify: boolean;
};
function invalid(message: string): never { throw new HttpError(400, message); }
function field(value: unknown, name: string, limit = 256) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || Buffer.byteLength(value) > limit || /[\r\n\0]/.test(value)) invalid(`${name}格式无效`);
  return value as string;
}
function object(value: any, name: string): Settings {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name}格式无效`);
  return value;
}
function endpoint(value: unknown) {
  const text = field(value, "Kubernetes API Server 地址", 2048).trim();
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || /[?#\\\s]/.test(text)) throw new Error();
    return url.href.replace(/\/$/, "");
  } catch { return invalid("Kubernetes API Server 地址须为不含凭据、查询参数或片段的 HTTP(S) 地址"); }
}
function namespace(value: unknown) {
  const text = field(value, "命名空间", 63);
  if (text && !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(text)) invalid("命名空间须为有效的 Kubernetes 命名空间名称");
  return text;
}
function embedded(value: unknown, name: string) {
  if (typeof value !== "string") return invalid(`Kubeconfig 的${name}数据无效`);
  const clean = value.replace(/[\r\n]/g, "");
  if (!clean || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) invalid(`Kubeconfig 的${name}数据无效`);
  const data = Buffer.from(clean, "base64");
  if (data.toString("base64") !== clean) invalid(`Kubeconfig 的${name}数据无效`);
  return data.toString("utf8");
}
function namedEntries(value: any, name: string) {
  if (value === undefined) return new Map<string, Settings>();
  if (!Array.isArray(value) || value.length > 10000) invalid(`Kubeconfig ${name}格式无效`);
  const entries = new Map<string, Settings>();
  for (const raw of value) {
    const item = object(raw, `Kubeconfig ${name}`), key = field(item.name, `Kubeconfig ${name}名称`);
    if (!key || entries.has(key)) invalid(`Kubeconfig ${name}名称为空或重复`);
    entries.set(key, item);
  }
  return entries;
}
function kubeDocument(raw: string) {
  if (!raw.trim() || Buffer.byteLength(raw) > kubeconfigLimit || raw.includes("\0")) invalid("请选择或粘贴非空 Kubeconfig，最大 1 MB");
  try {
    // Never expose parser errors: their source excerpts may contain credentials.
    const doc = parseDocument(raw, { prettyErrors: false, uniqueKeys: true, strict: true, stringKeys: true, logLevel: "silent" });
    if (doc.errors.length || doc.warnings.length) throw new Error();
    let nodes = 0;
    visit(doc, { Node(_key, node, path) {
      if (++nodes > 20000 || path.length > 64 || isAlias(node) || "anchor" in node && node.anchor) throw new Error();
    } });
    const data = object(doc.toJS({ maxAliasCount: 0 }), "Kubeconfig");
    if (data.kind !== undefined && data.kind !== "Config" || data.apiVersion !== undefined && data.apiVersion !== "v1") throw new Error();
    return data;
  } catch { return invalid("Kubeconfig 须为有效的单个 v1 YAML/JSON 文档，不含引用、重复字段或过深结构"); }
}

/** Uploaded content only: no plugin execution, proxy, environment or file lookup. */
function resolve(settings: Settings, secrets: Secrets, registerSecret: (value: string) => void): Connection {
  const method = settings.authMethod ?? "token", tlsMode = settings.tlsMode ?? "config", timeout = settings.requestTimeout ?? 10;
  if (!["kubeconfig", "token"].includes(method)) invalid("不支持的 Kubernetes 认证方式");
  if (!["config", "verify", "skip"].includes(tlsMode)) invalid("不支持的 TLS 验证方式");
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60) invalid("Kubernetes 超时须为 1～60 秒的整数");
  let selected = field(settings.context, "Context"), ns = namespace(settings.namespace), address = settings.endpoint;
  const result: Connection = { metadata: {}, token: "", username: "", password: "", serverName: "", verify: true };
  if (method === "kubeconfig") {
    const doc = kubeDocument(secrets.kubeconfig ?? "");
    const contexts = namedEntries(doc.contexts, "Context"), clusters = namedEntries(doc.clusters, "集群"), users = namedEntries(doc.users, "用户");
    selected ||= field(doc["current-context"], "current-context");
    const current = contexts.get(selected);
    if (!current) invalid("未找到所选 Context，请检查 current-context 或填写 Context 名称");
    const context = object(current.context, "Kubeconfig Context");
    const clusterEntry = clusters.get(field(context.cluster, "Context 集群引用"));
    if (!clusterEntry) invalid("Context 引用的集群不存在");
    const cluster = object(clusterEntry.cluster, "Kubeconfig 集群"), userName = field(context.user, "Context 用户引用");
    const userEntry = userName ? users.get(userName) : undefined;
    if (userName && !userEntry) invalid("Context 引用的用户不存在");
    const user = userEntry ? object(userEntry.user, "Kubeconfig 用户") : {};
    if (user.exec !== undefined || user["auth-provider"] !== undefined) invalid("此版本不运行 Kubeconfig 认证插件，请使用内嵌 Token 或证书");
    if (cluster["proxy-url"]) invalid("此版本暂不支持 Kubeconfig 的 proxy-url");
    if (user.tokenFile || user["token-file"] || cluster["certificate-authority"] && !cluster["certificate-authority-data"] ||
        user["client-certificate"] && !user["client-certificate-data"] || user["client-key"] && !user["client-key-data"])
      invalid("请使用内嵌 Token、CA 和客户端证书，不读取外部凭据文件");
    if (["as", "as-uid", "as-groups", "as-user-extra"].some(key => user[key] !== undefined)) invalid("此版本暂不支持 Kubeconfig 身份模拟");
    address = cluster.server;
    result.token = field(user.token, "Kubeconfig Token", 16384);
    result.username = field(user.username, "Kubeconfig 用户名");
    result.password = field(user.password, "Kubeconfig 密码", 16384);
    result.serverName = field(cluster["tls-server-name"], "Kubeconfig TLS server name");
    if (result.serverName && !/^[a-zA-Z0-9_.:-]+$/.test(result.serverName)) invalid("Kubeconfig TLS server name 无效");
    if (cluster["insecure-skip-tls-verify"] !== undefined && typeof cluster["insecure-skip-tls-verify"] !== "boolean") invalid("Kubeconfig TLS 验证选项无效");
    result.verify = cluster["insecure-skip-tls-verify"] !== true;
    if (cluster["certificate-authority-data"]) {
      result.ca = embedded(cluster["certificate-authority-data"], "CA 证书");
      try { new X509Certificate(result.ca); } catch { invalid("Kubeconfig CA 证书无效"); }
    }
    if (user["client-certificate-data"] || user["client-key-data"]) {
      result.cert = embedded(user["client-certificate-data"], "客户端证书");
      result.key = embedded(user["client-key-data"], "客户端密钥");
    }
    ns ||= namespace(context.namespace);
    for (const value of [result.token, result.password, result.key, user["client-key-data"]]) if (value) registerSecret(value);
  } else result.token = field(secrets.token, "Token", 16384);
  if (/[\s\0]/.test(result.token)) invalid("Kubeconfig Token 格式无效");
  if (tlsMode === "verify") result.verify = true;
  if (tlsMode === "skip") result.verify = false;
  try { createSecureContext({ ca: result.ca, cert: result.cert, key: result.key, minVersion: "TLSv1.2" }); }
  catch { invalid("Kubeconfig 客户端证书与密钥无效或不匹配"); }
  result.metadata = { authMethod: method, endpoint: endpoint(address), context: selected, namespace: ns || "default", requestTimeout: timeout, tlsMode };
  return result;
}

export function normalizeKubernetesSettings(settings: Settings, secrets: Secrets, registerSecret: (value: string) => void) {
  return resolve(settings, secrets, registerSecret).metadata;
}

/** Explicit GET only. HTTP redirects are errors and never receive credentials. */
export async function testKubernetesConnection(settings: Settings, secrets: Secrets, signal: AbortSignal, registerSecret: (value: string) => void) {
  const connection = resolve(settings, secrets, registerSecret), meta = connection.metadata;
  if (settings.endpoint !== meta.endpoint) invalid("保存的集群地址与 Kubeconfig 不一致，请重新配置资源");
  const url = new URL(meta.endpoint + "/version"), cancel = new AbortController();
  const timer = setTimeout(() => cancel.abort(), meta.requestTimeout * 1000);
  const combined = AbortSignal.any([signal, cancel.signal]);
  try {
    const body = await new Promise<string>((ok, fail) => {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (connection.token) headers.Authorization = "Bearer " + connection.token;
      else if (connection.username || connection.password) headers.Authorization = "Basic " + Buffer.from(connection.username + ":" + connection.password).toString("base64");
      const options = { method: "GET", headers, signal: combined, agent: false as const, maxHeaderSize: 64 * 1024, minVersion: "TLSv1.2" as const,
        ca: connection.ca, cert: connection.cert, key: connection.key, rejectUnauthorized: connection.verify,
        servername: connection.serverName && !isIP(connection.serverName) ? connection.serverName : undefined,
        checkServerIdentity: (_name: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(connection.serverName || url.hostname.replace(/^\[|\]$/g, ""), cert) };
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, response => {
        const status = response.statusCode ?? 0;
        const error = (message: string) => { response.destroy(); fail(new HttpError(status === 401 || status === 403 ? status : 502, message)); };
        if (status >= 300 && status < 400) return error("Kubernetes 地址发生重定向，请填写准确 API 地址");
        if (status === 401 || status === 403) return error("Kubernetes 认证失败或没有读取权限");
        if (status !== 200) return error(`Kubernetes API 请求失败（HTTP ${status}）`);
        if (!/^application\/json\b/i.test(String(response.headers["content-type"] ?? ""))) return error("服务未返回有效的 Kubernetes JSON 响应");
        let size = 0; const chunks: Buffer[] = [];
        response.on("data", chunk => {
          size += chunk.length;
          if (size > 64 * 1024) error("Kubernetes 版本响应过大");
          else chunks.push(Buffer.from(chunk));
        });
        response.on("error", fail);
        response.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
      });
      request.on("error", fail); request.end();
    });
    let value: any;
    try { value = JSON.parse(body); } catch { throw new HttpError(502, "服务未返回有效的 Kubernetes JSON 响应"); }
    if (!value || typeof value.gitVersion !== "string" || value.gitVersion.length > 128 || !/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(value.gitVersion))
      throw new HttpError(502, "服务未返回有效的 Kubernetes 版本");
    return { success: true, message: "连接成功", version: value.gitVersion, endpoint: meta.endpoint, context: meta.context, namespace: meta.namespace };
  } catch (error) {
    if (signal.aborted) throw new HttpError(408, "连接测试已取消或超时");
    if (cancel.signal.aborted) throw new HttpError(408, "连接超时，请检查集群地址或调整超时");
    if (error instanceof HttpError) throw error;
    const code = String((error as NodeJS.ErrnoException)?.code ?? "");
    if (/CERT|TLS|SSL|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY/.test(code)) throw new HttpError(400, "TLS 证书验证失败，请检查 Kubeconfig 的 CA 证书与服务地址");
    throw new HttpError(502, "无法连接 Kubernetes API Server，请检查地址、网络和证书配置");
  } finally { clearTimeout(timer); }
}
