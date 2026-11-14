import { existsSync, lstatSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { HttpError, id, now } from "./store";
import { text } from "./tasks";
import type { LakeSecurity } from "./security";

type TokenRecord = { id: string; name: string; token: string; roles?: string[]; createdAt: string };
type GatewayConfig = { version: 1; tokens: TokenRecord[] };
export type GatewayTokenView = { id: string; name: string; roles?: string[]; createdAt: string };
export type GatewayAuth = { id: string; roles?: string[] };

const maximum = 1000000;
const empty = (): GatewayConfig => ({ version: 1, tokens: [] });
function privateFile(path: string) {
  const info = lstatSync(path), parent = lstatSync(dirname(path));
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > maximum ||
    !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 ||
    process.platform !== "win32" && (info.uid !== process.getuid?.() || parent.uid !== process.getuid?.()))
    throw new HttpError(409, "网关凭据须为当前用户的私有文件");
}
function equal(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && a.equals(b);
}

/** Scoped gateway credentials for external agent clients. The plaintext token
 * lives only in the private secrets file; the backend never stores a copy. */
export class LakeGateway {
  private closed = false;
  private secretValues = new Set<string>();
  constructor(readonly home: string, readonly security?: { check(): void }) {}
  private get path() { return join(this.home, "secrets/mcp-gateway.json"); }
  private config(): GatewayConfig {
    if (!existsSync(this.path)) return empty();
    privateFile(this.path);
    let value: GatewayConfig; try { value = JSON.parse(readFileSync(this.path, "utf8")); } catch { throw new HttpError(409, "网关凭据格式无效"); }
    if (value?.version !== 1 || !Array.isArray(value.tokens) || value.tokens.some(row =>
      !row || typeof row.id !== "string" || typeof row.name !== "string" || typeof row.token !== "string" ||
      typeof row.createdAt !== "string" || row.roles !== undefined && (!Array.isArray(row.roles) || row.roles.some(role => typeof role !== "string"))))
      throw new HttpError(409, "网关凭据版本或记录无效");
    for (const row of value.tokens) this.secretValues.add(row.token);
    return value;
  }
  private write(config: GatewayConfig) {
    const directory = dirname(this.path); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || process.platform !== "win32" && info.uid !== process.getuid?.())
      throw new HttpError(409, "网关凭据目录无效");
    const body = JSON.stringify(config, null, 2);
    if (Buffer.byteLength(body) >= maximum) throw new HttpError(413, "网关凭据超过大小限制");
    const temporary = join(directory, ".gateway-" + id());
    const file = openSync(temporary, "wx", 0o600);
    try { writeFileSync(file, body + "\n"); fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, this.path);
  }
  private static view(row: TokenRecord): GatewayTokenView {
    return { id: row.id, name: row.name, ...(row.roles?.length ? { roles: [...row.roles] } : {}), createdAt: row.createdAt };
  }
  create(input: Record<string, unknown>): GatewayTokenView & { token: string } {
    this.security?.check(); this.closed || this.config();
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["name", "roles"].includes(key)))
      throw new HttpError(400, "网关凭据字段无效");
    const name = text(input.name, "name", 120);
    const roles = input.roles === undefined ? undefined : (() => {
      if (!Array.isArray(input.roles) || !input.roles.length || input.roles.length > 64 || input.roles.some(role => typeof role !== "string")) throw new HttpError(400, "允许的专员须为非空身份列表");
      const distinct = [...new Set(input.roles as string[])];
      for (const role of distinct) if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(role)) throw new HttpError(400, "专员身份无效");
      return distinct;
    })();
    const config = this.config();
    if (config.tokens.length >= 64) throw new HttpError(409, "网关凭据已达上限，请先删除不再使用的凭据");
    if (config.tokens.some(row => row.name === name)) throw new HttpError(409, "存在同名网关凭据，请改名后重试");
    const row: TokenRecord = { id: id(), name, token: "lkgw_" + randomBytes(24).toString("hex"), createdAt: now(), ...(roles && { roles }) };
    this.write({ ...config, tokens: [...config.tokens, row] });
    this.secretValues.add(row.token);
    return { ...LakeGateway.view(row), token: row.token };
  }
  list(): { tokens: GatewayTokenView[] } {
    this.closed || this.config();
    return { tokens: this.config().tokens.map(row => LakeGateway.view(row)) };
  }
  remove(tokenId: unknown) {
    this.security?.check();
    if (typeof tokenId !== "string" || !tokenId) throw new HttpError(400, "网关凭据身份无效");
    const config = this.config();
    if (!config.tokens.some(row => row.id === tokenId)) throw new HttpError(404, "网关凭据不存在");
    this.write({ ...config, tokens: config.tokens.filter(row => row.id !== tokenId) });
    return { ok: true };
  }
  /** Constant-time bearer check against the private file. Cookie auth is
   * deliberately not accepted: only an explicit token grants the gateway. */
  authenticate(bearer: unknown): GatewayAuth {
    if (typeof bearer !== "string" || !bearer) throw new HttpError(401, "需要 Lake 网关凭据");
    const config = this.config();
    const row = config.tokens.find(candidate => equal(bearer, candidate.token));
    if (!row) throw new HttpError(401, "需要 Lake 网关凭据");
    return { id: row.id, ...(row.roles?.length ? { roles: [...row.roles] } : {}) };
  }
  /** Resolve the plaintext token a local stdio client should present. Only
   * the owner of the private secrets file can call this process-side. */
  resolveToken(tokenId?: string): { id: string; token: string } {
    const tokens = this.config().tokens;
    const row = tokenId ? tokens.find(candidate => candidate.id === tokenId) : tokens.length === 1 ? tokens[0] : undefined;
    if (!row) throw new HttpError(404, tokenId ? "指定的网关凭据不存在" : "存在多个网关凭据，请用 --token-id 指定其中一个");
    return { id: row.id, token: row.token };
  }
  requireRole(auth: GatewayAuth, roleId: string) {
    if (auth.roles && !auth.roles.includes(roleId)) throw new HttpError(403, "此网关凭据未被允许访问该专员");
  }
  scrub(value: string) { for (const secret of this.secretValues) value = value.split(secret).join("[REDACTED]"); return value; }
  close() { this.closed = true; }
}
