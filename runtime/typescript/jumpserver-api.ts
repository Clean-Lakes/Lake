import { createHmac, X509Certificate } from "node:crypto";
import { request as http } from "node:http";
import { request as https } from "node:https";
import { isIP } from "node:net";
import type { JumpServerLogin } from "../../web-agent/shared/contracts";
import { HttpError } from "./store";

export const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const invalid = () => new HttpError(502, "JumpServer 返回的授权数据不完整");
export const validName = (v: unknown): v is string =>
  typeof v === "string" && !!v.trim() && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v);
export const hostName = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 253 && (!!isIP(v) || /^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(v));
export type DirectoryNode = { id: string; key: string; name: string };
export type DirectoryAsset = { id: string; name: string; nodes: string[]; endpoint: string; ssh: boolean };
export type Directory = { nodes: DirectoryNode[]; assets: DirectoryAsset[] };
export type AuthorizedAccount = {id: string; alias: string; name: string};
const keyOf = (v: any): unknown => typeof v === "string" ? v : v?.id;
const enumValue = (v: any): unknown => typeof v === "string" ? v : v?.value;

export class JumpServerUnknownResult extends HttpError {}
export function checkKoKoExit(code: number | undefined, stdout: string, stderr: string) {
  const output=(stdout+"\n"+stderr).trim();
  if (output==="SSH Command not support ACL review ticket")
    throw new HttpError(403,"KoKo 的非交互命令不支持复核工单，堡垒机已阻止执行");
  if (/^(?:Not auth user\.|not ssh asset connection token|not found ctx id|Not support scp command|No support vscode like requested\.)$/i.test(output))
    throw new HttpError(403,"KoKo 已拒绝这次 SSH 请求");
  if (/^(?:ssh: |dial tcp |connect to .* (?:error|failed)|get connect token error)/i.test(output))
    throw new JumpServerUnknownResult(502,"KoKo 连接资产失败，请在堡垒机核对会话记录");
  // KoKo can close a denied command with no diagnostics or an implicit zero.
  if (code===undefined || code===0 && !output)
    throw new JumpServerUnknownResult(502,"KoKo 未返回可核实的命令结果，请在堡垒机会话审计中核对");
}

function accountCurrent(value: unknown) {
  if (value == null) return true;
  if (typeof value !== "string") return false;
  const iso=value.replace(/^(\d{4})\/(\d{2})\/(\d{2}) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)$/,"$1-$2-$3T$4$5:$6");
  return Date.parse(iso)>Date.now();
}

export function loginConfiguration(input: JumpServerLogin): JumpServerLogin {
  let url: URL;
  try { url = new URL(input.origin); } catch { throw new HttpError(400, "请输入完整的 JumpServer API 地址"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new HttpError(400, "请使用 JumpServer 服务根地址，不含 Luna 路径或登录信息");
  if (url.protocol === "http:" && !["localhost","127.0.0.1","[::1]"].includes(url.hostname) && input.allowHttp !== true)
    throw new HttpError(400, "此地址使用 HTTP，请确认内网明文传输或改用 HTTPS");
  if (!uuid.test(input.orgId) || !["accessKey","bearer"].includes(input.authMethod) ||
      input.authMethod === "accessKey" && !uuid.test(input.keyId ?? "") ||
      typeof input.secret !== "string" || !input.secret || input.secret.length > 8192 || /[\x00-\x20\x7f]/.test(input.secret))
    throw new HttpError(400, "请核对组织 UUID 和个人 API 凭据");
  const ca = input.ca?.trim();
  if (ca) {
    try { if (ca.length > 64000 || !ca.startsWith("-----BEGIN CERTIFICATE-----") || ca.includes("PRIVATE KEY")) throw Error(); new X509Certificate(ca); }
    catch { throw new HttpError(400, "自签证书请提供 PEM 格式的 CA 公钥证书"); }
  }
  return {origin:url.origin, orgId:input.orgId.toLowerCase(), authMethod:input.authMethod, secret:input.secret,
    ...(input.authMethod === "accessKey" ? {keyId:input.keyId} : {}), ...(ca ? {ca} : {}), allowHttp:input.allowHttp === true};
}

/** Only this client sees the personal secret. Paths are constructed locally; redirects are never followed. */
export class JumpServerAPI {
  constructor(readonly login: JumpServerLogin) {}
  private request(path: string, signal: AbortSignal, data?: object): Promise<any> {
    const url = new URL("/api/v1/" + path, this.login.origin);
    const method = data ? "POST" : "GET", date = new Date().toUTCString();
    const headers: Record<string,string> = {Accept:"application/json", Date:date, "X-JMS-ORG":this.login.orgId};
    if (this.login.authMethod === "accessKey") {
      const signed = "(request-target): " + method.toLowerCase() + " " + url.pathname + url.search + "\naccept: application/json\ndate: " + date;
      const signature = createHmac("sha256", this.login.secret).update(signed).digest("base64");
      headers.Authorization = 'Signature keyId="' + this.login.keyId + '",algorithm="hmac-sha256",headers="(request-target) accept date",signature="' + signature + '"';
    } else headers.Authorization = "Bearer " + this.login.secret;
    if (data) headers["Content-Type"] = "application/json";
    const cancel = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
    return new Promise((resolve, reject) => {
      const send = url.protocol === "https:" ? https : http;
      const req = send(url, {method, headers, ca:this.login.ca, signal:cancel}, response => {
        const status = response.statusCode ?? 500;
        if (status < 200 || status >= 300) {
          response.resume();
          const forbidden = status === 401 || status === 403;
          reject(new HttpError(forbidden ? status : status === 404 ? 404 : 502, forbidden
            ? "JumpServer 已拒绝当前身份或操作，请核对凭据和授权"
            : "JumpServer 请求未完成（HTTP " + status + "）"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 12 * 1024 * 1024) { reject(invalid()); req.destroy(); }
          else chunks.push(chunk);
        });
        response.on("error", () => reject(invalid()));
        response.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(invalid()); } });
      });
      req.on("error", () => reject(new HttpError(502, "无法连接 JumpServer，请核对地址、TLS 证书和网络")));
      req.end(data ? JSON.stringify(data) : undefined);
    });
  }
  async profile(signal: AbortSignal) {
    const p = await this.request("users/profile/", signal);
    if (!uuid.test(p?.id) || !validName(p.username) || p.is_active === false)
      throw new HttpError(403, "JumpServer 当前用户身份无效");
    return {userId:p.id as string, username:p.username as string};
  }
  private async list(path: string, signal: AbortSignal) {
    const rows: any[] = [];
    let expected: number | undefined;
    for (let page = 0; page < 100; page++) {
      const joiner = path.includes("?") ? "&" : "?";
      const response = await this.request(path + joiner + "limit=500&offset=" + rows.length, signal);
      const items = Array.isArray(response) ? response : response?.results;
      if (!Array.isArray(items) || rows.length + items.length > 25000) throw invalid();
      rows.push(...items);
      if (Array.isArray(response)) return rows;
      if (!Object.hasOwn(response, "next")) throw invalid();
      if (Number.isSafeInteger(response.count) && response.count >= 0) {
        if (expected !== undefined && expected !== response.count) throw invalid();
        expected = response.count;
      }
      if (response.next == null) {
        if (expected !== undefined && rows.length !== expected) throw invalid();
        return rows;
      }
      if (typeof response.next !== "string" || !items.length) throw invalid();
    }
    throw invalid();
  }
  async nodes(signal: AbortSignal): Promise<DirectoryNode[]> {
    const records = await this.list("perms/users/self/nodes/", signal);
    const nodes: DirectoryNode[] = [];
    for (const n of records) {
      // These are virtual views in JumpServer, with literal text IDs instead of organizational node UUIDs.
      if (n?.id === n?.key && ["favorite", "ungrouped"].includes(n?.id)) continue;
      if (!uuid.test(n?.org_id) || !uuid.test(n?.id)) throw invalid();
      if (n.org_id !== this.login.orgId) continue;
      if (!validName(n.key) || !validName(n.value ?? n.name)) throw invalid();
      nodes.push({id:n.id, key:n.key, name:n.value ?? n.name});
    }
    if (new Set(nodes.map(n=>n.key)).size !== nodes.length || new Set(nodes.map(n=>n.id)).size !== nodes.length) throw invalid();
    return nodes;
  }
  async directory(rootId: string | null, signal: AbortSignal): Promise<Directory> {
    const nodes = await this.nodes(signal);
    const root = rootId ? nodes.find(n=>n.id===rootId) : undefined;
    if (rootId && !root) return {nodes:[], assets:[]};
    const included = root ? nodes.filter(n=>n.id===root.id || n.key.startsWith(root.key + ":")) : nodes;
    const nodeIds = new Set(included.map(n=>n.id));
    // The active filter requests the exact queryset count. JumpServer's list serializer omits protocols.
    const path = "perms/users/self/assets/?is_active=true" + (root ? "&node_id=" + root.id : "");
    const [records, sshRecords] = await Promise.all([this.list(path, signal), this.list(path + "&protocols=ssh", signal)]);
    if (sshRecords.some(a => !uuid.test(a?.id) || !uuid.test(a?.org_id))) throw invalid();
    const sshIds = new Set(sshRecords.filter(a => a.org_id === this.login.orgId).map(a => a.id));
    const assets: DirectoryAsset[] = [];
    for (const a of records) {
      if (!uuid.test(a?.id) || !uuid.test(a?.org_id) || !validName(a.name) || !Array.isArray(a.nodes)) throw invalid();
      if (a.org_id !== this.login.orgId || a.is_active === false) continue;
      const parents = [...new Set<string>(a.nodes.map(keyOf).filter((v: unknown): v is string => typeof v === "string" && nodeIds.has(v)))];
      if (root && !parents.length) continue;
      if (a.nodes.some((n: unknown) => !uuid.test(String(keyOf(n))))) throw invalid();
      const ssh = sshIds.has(a.id);
      assets.push({id:a.id, name:a.name, endpoint:String(a.address ?? ""), nodes:parents, ssh});
    }
    if (new Set(assets.map(a=>a.id)).size !== assets.length) throw invalid();
    return {nodes:included, assets};
  }
  async accounts(assetId: string, signal: AbortSignal): Promise<AuthorizedAccount[]> {
    const a = await this.request("perms/users/self/assets/" + assetId + "/", signal);
    if (a?.id !== assetId || a.org_id !== this.login.orgId || a.is_active === false ||
        !Array.isArray(a.permed_protocols) || !a.permed_protocols.some((p: any)=>p?.name === "ssh" || p === "ssh"))
      throw new HttpError(403,"此资产未授权 SSH 访问");
    if (!Array.isArray(a.permed_accounts)) throw invalid();
    return a.permed_accounts.filter((p: any)=>uuid.test(p?.id) && validName(p.alias) && Array.isArray(p.actions) &&
      p.actions.some((action: any)=>enumValue(action)==="connect") && accountCurrent(p.date_expired) && !["@INPUT","@USER"].includes(p.alias))
      .map((p: any)=>({id:p.id, alias:p.alias, name:validName(p.name) ? p.name : p.alias}));
  }
  async ticket(userId: string, assetId: string, account: AuthorizedAccount, signal: AbortSignal) {
    const token = await this.request("authentication/connection-token/", signal, {asset:assetId, account:account.alias, protocol:"ssh", connect_method:"ssh_client"});
    if (token?.is_active !== true || token.is_expired === true || token.is_reusable !== false)
      throw new HttpError(403, "JumpServer 连接未获准，需在堡垒机完成认证或审批");
    if ((token.user != null && keyOf(token.user) !== userId) ||
        (token.asset != null && keyOf(token.asset) !== assetId) ||
        (token.org_id != null && token.org_id !== this.login.orgId) ||
        (token.account != null && token.account !== account.alias) ||
        (token.protocol != null && enumValue(token.protocol) !== "ssh") ||
        (token.connect_method != null && enumValue(token.connect_method) !== "ssh_client"))
      throw new HttpError(403, "JumpServer 返回的连接身份与当前绑定不一致");
    if (!uuid.test(token.id) || typeof token.value !== "string" || !token.value || token.value.length > 1024) throw invalid();
    return {id:token.id as string, password:token.value as string};
  }
}
