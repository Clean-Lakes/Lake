import { existsSync, lstatSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { HttpError, id, now } from "./store";
import { text } from "./tasks";
import type { GatewayApprovalPolicy, GatewayConnection, GatewayInviteStatus, GatewayInviteView, GatewayResourceGrant, GatewayRouting } from "../../web-agent/shared/contracts";

type InviteRecord = {
  id: string;
  token: string;
  recipient?: string;
  createdAt: string;
  expiresAt: string;
  redeemedAt?: string;
  revokedAt?: string;
};
type ConnectionRecord = Pick<GatewayConnection, 'projectId' | 'enabled' | 'routing' | 'resourceGrants' | 'updatedAt'> & { invites?: InviteRecord[] };
type TokenRecord = { id: string; name: string; token: string; roles?: string[]; createdAt: string; connection?: ConnectionRecord };
type GatewayConfig = { version: 1; tokens: TokenRecord[] };
export type GatewayTokenView = { id: string; name: string; roles?: string[]; createdAt: string };
export type GatewayAuth = { id: string; roles?: string[]; connection?: GatewayConnection };

const maximum = 4000000;
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
  return a.length === b.length && timingSafeEqual(a, b);
}
const identity = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) throw new HttpError(400, `${field} 身份无效`);
  return value;
};
function routing(value: unknown): GatewayRouting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '处理方式无效');
  const input = value as Record<string, unknown>;
  if (input.mode === 'pilot' && Object.keys(input).every(key => key === 'mode')) return {mode: 'pilot'};
  if (input.mode === 'specialist' && Object.keys(input).every(key => ['mode', 'roleId'].includes(key)))
    return {mode: 'specialist', roleId: identity(input.roleId, '专员')};
  throw new HttpError(400, '处理方式无效');
}
function fields(input: Record<string, unknown>, allowed: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)))
    throw new HttpError(400, '接入连接字段无效');
}
function resourceGrants(value: unknown): GatewayResourceGrant[] {
  if (!Array.isArray(value) || value.length > 4096) throw new HttpError(400, '资源授权列表无效');
  const seen = new Set<string>(), out: GatewayResourceGrant[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(400, '资源授权条目无效');
    const row = item as Record<string, unknown>;
    fields(row, ['resourceId', 'approvalPolicy', 'expiresAt']);
    const resourceId = identity(row.resourceId, '资源');
    if (seen.has(resourceId)) throw new HttpError(400, '资源授权列表包含重复资源');
    seen.add(resourceId);
    const policy = row.approvalPolicy;
    if (policy !== 'always_approve' && policy !== 'auto_in_scope') throw new HttpError(400, '审批方式无效');
    let expiresAt: string | undefined;
    if (row.expiresAt !== undefined && row.expiresAt !== null && row.expiresAt !== '') {
      if (typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt))) throw new HttpError(400, '授权有效期格式无效');
      expiresAt = new Date(Date.parse(row.expiresAt)).toISOString();
    }
    out.push({ resourceId, approvalPolicy: policy as GatewayApprovalPolicy, ...(expiresAt ? { expiresAt } : {}) });
  }
  return out;
}
function inviteStatus(row: InviteRecord, at = Date.now()): GatewayInviteStatus {
  if (row.revokedAt) return 'revoked';
  if (row.redeemedAt) return 'redeemed';
  if (Date.parse(row.expiresAt) <= at) return 'expired';
  return 'active';
}
function inviteView(row: InviteRecord, origin: string, roleName?: string): GatewayInviteView {
  const status = inviteStatus(row);
  const inviteUrl = status === 'active' ? `${origin}/api/gateway/invites/${row.token}` : undefined;
  const invitePrompt = inviteUrl ? `帮我连接 Lake 的${roleName || '专员'}：${inviteUrl}` : undefined;
  return {
    id: row.id,
    ...(row.recipient ? { recipient: row.recipient } : {}),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.redeemedAt ? { redeemedAt: row.redeemedAt } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
    status,
    ...(inviteUrl ? { inviteUrl, invitePrompt } : {}),
  };
}
export function activeResourceGrants(connection: Pick<GatewayConnection, 'resourceGrants'>, at = Date.now()): GatewayResourceGrant[] {
  return (connection.resourceGrants ?? []).filter(grant => !grant.expiresAt || Date.parse(grant.expiresAt) > at);
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
    for (const row of value.tokens) {
      this.secretValues.add(row.token);
      for (const invite of row.connection?.invites ?? []) if (typeof invite?.token === 'string') this.secretValues.add(invite.token);
    }
    for (const row of value.tokens) if (row.connection !== undefined) {
      try {
        if (row.roles !== undefined) throw new Error('mixed scope');
        fields(row.connection as unknown as Record<string, unknown>, ['projectId', 'enabled', 'routing', 'resourceGrants', 'invites', 'updatedAt']);
        identity(row.connection.projectId, '项目'); routing(row.connection.routing);
        if (row.connection.resourceGrants !== undefined) resourceGrants(row.connection.resourceGrants);
        if (row.connection.invites !== undefined) {
          if (!Array.isArray(row.connection.invites) || row.connection.invites.length > 64) throw new Error('invalid invites');
          for (const invite of row.connection.invites) {
            if (!invite || typeof invite !== 'object' || typeof invite.id !== 'string' || typeof invite.token !== 'string' ||
              typeof invite.createdAt !== 'string' || typeof invite.expiresAt !== 'string' ||
              !Number.isFinite(Date.parse(invite.createdAt)) || !Number.isFinite(Date.parse(invite.expiresAt)))
              throw new Error('invalid invite');
          }
        }
        if (typeof row.connection.enabled !== 'boolean' || typeof row.connection.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.connection.updatedAt))) throw new Error('invalid connection');
      } catch { throw new HttpError(409, '接入连接记录无效'); }
    }
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
    return { tokens: this.config().tokens.filter(row => !row.connection).map(row => LakeGateway.view(row)) };
  }
  private static connectionView(row: TokenRecord): GatewayConnection {
    if (!row.connection) throw new HttpError(404, '接入连接不存在');
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      projectId: row.connection.projectId,
      enabled: row.connection.enabled,
      routing: {...row.connection.routing},
      ...(row.connection.resourceGrants !== undefined ? {resourceGrants: row.connection.resourceGrants.map(grant => ({...grant}))} : {}),
      updatedAt: row.connection.updatedAt,
    };
  }
  connections(): GatewayConnection[] { return this.config().tokens.filter(row => row.connection).map(LakeGateway.connectionView); }
  connection(connectionId: unknown): GatewayConnection {
    const row = this.config().tokens.find(row => row.id === connectionId && row.connection);
    if (!row) throw new HttpError(404, '接入连接不存在');
    return LakeGateway.connectionView(row);
  }
  specialistConnection(projectId: string, roleId: string): GatewayConnection | null {
    const matches = this.config().tokens.filter(row =>
      row.connection && row.connection.projectId === projectId &&
      row.connection.routing.mode === 'specialist' && row.connection.routing.roleId === roleId);
    if (!matches.length) return null;
    matches.sort((a, b) => Number(b.connection!.enabled) - Number(a.connection!.enabled) || b.connection!.updatedAt.localeCompare(a.connection!.updatedAt));
    return LakeGateway.connectionView(matches[0]!);
  }
  createConnection(input: Record<string, unknown>): GatewayConnection {
    this.security?.check(); fields(input, ['name', 'projectId', 'routing', 'resourceGrants']);
    const name = text(input.name, 'name', 120), projectId = identity(input.projectId, '项目');
    const route = routing(input.routing ?? {mode: 'pilot'}), config = this.config();
    const grants = input.resourceGrants === undefined ? undefined : resourceGrants(input.resourceGrants);
    if (config.tokens.length >= 64) throw new HttpError(409, '接入凭据已达上限，请先删除不再使用的连接');
    if (config.tokens.some(row => row.name === name)) throw new HttpError(409, '存在同名接入凭据，请改名后重试');
    const createdAt = now();
    const row: TokenRecord = {id: id(), name, token: 'lkgw_' + randomBytes(24).toString('hex'), createdAt,
      connection: {projectId, routing: route, enabled: true, ...(grants !== undefined ? {resourceGrants: grants} : {}), updatedAt: createdAt}};
    this.write({...config, tokens: [...config.tokens, row]}); this.secretValues.add(row.token);
    return LakeGateway.connectionView(row);
  }
  updateConnection(connectionId: string, input: Record<string, unknown>): GatewayConnection {
    this.security?.check(); fields(input, ['name', 'enabled', 'routing', 'resourceGrants', 'expectedUpdatedAt']);
    const config = this.config(), row = config.tokens.find(row => row.id === connectionId && row.connection);
    if (!row?.connection) throw new HttpError(404, '接入连接不存在');
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== row.connection.updatedAt) throw new HttpError(409, '连接配置已变化，请刷新后重试');
    const name = input.name === undefined ? row.name : text(input.name, 'name', 120);
    if (config.tokens.some(other => other.id !== row.id && other.name === name)) throw new HttpError(409, '存在同名接入凭据，请改名后重试');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new HttpError(400, '启用状态须为布尔值');
    const route = input.routing === undefined ? row.connection.routing : routing(input.routing);
    const grants = input.resourceGrants === undefined ? row.connection.resourceGrants : resourceGrants(input.resourceGrants);
    const next: TokenRecord = {...row, name, connection: {
      ...row.connection,
      enabled: input.enabled as boolean ?? row.connection.enabled,
      routing: route,
      ...(grants !== undefined ? {resourceGrants: grants} : {}),
      updatedAt: new Date(Math.max(Date.now(), Date.parse(row.connection.updatedAt) + 1)).toISOString(),
    }};
    this.write({...config, tokens: config.tokens.map(entry => entry.id === row.id ? next : entry)});
    return LakeGateway.connectionView(next);
  }
  saveSpecialistGrants(input: {
    projectId: string;
    roleId: string;
    roleName: string;
    resourceGrants: unknown;
    enabled?: boolean;
    expectedUpdatedAt?: string;
  }): GatewayConnection {
    this.security?.check();
    const projectId = identity(input.projectId, '项目');
    const roleId = identity(input.roleId, '专员');
    const grants = resourceGrants(input.resourceGrants);
    const existing = this.specialistConnection(projectId, roleId);
    if (existing) {
      return this.updateConnection(existing.id, {
        resourceGrants: grants,
        ...(input.enabled !== undefined ? {enabled: input.enabled} : {}),
        ...(input.expectedUpdatedAt !== undefined ? {expectedUpdatedAt: input.expectedUpdatedAt} : {}),
      });
    }
    const config = this.config();
    const base = `${input.roleName.trim() || '专员'} MCP`.slice(0, 108);
    let candidate = base, suffix = 2;
    while (config.tokens.some(row => row.name === candidate)) candidate = `${base} ${suffix++}`;
    return this.createConnection({
      name: candidate,
      projectId,
      routing: {mode: 'specialist', roleId},
      resourceGrants: grants,
    });
  }
  listInvites(connectionId: string, origin: string, roleName?: string): GatewayInviteView[] {
    const row = this.config().tokens.find(entry => entry.id === connectionId && entry.connection);
    if (!row?.connection) throw new HttpError(404, '接入连接不存在');
    return (row.connection.invites ?? [])
      .map(invite => inviteView(invite, origin, roleName))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  createInvite(connectionId: string, input: Record<string, unknown>, origin: string, roleName: string): GatewayInviteView {
    this.security?.check();
    fields(input, ['recipient', 'ttlMinutes']);
    const config = this.config(), row = config.tokens.find(entry => entry.id === connectionId && entry.connection);
    if (!row?.connection) throw new HttpError(404, '接入连接不存在');
    if (!row.connection.enabled) throw new HttpError(409, '连接已停用，请先启用后再生成邀请');
    const recipient = input.recipient === undefined || input.recipient === '' ? undefined : text(input.recipient, 'recipient', 80);
    const ttlMinutes = input.ttlMinutes === undefined ? 15 : Number(input.ttlMinutes);
    if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 1440) throw new HttpError(400, '邀请有效期须为 5–1440 分钟');
    const createdAt = now();
    const expiresAt = new Date(Date.parse(createdAt) + ttlMinutes * 60_000).toISOString();
    const invite: InviteRecord = {
      id: id(),
      token: 'lkiv_' + randomBytes(24).toString('hex'),
      ...(recipient ? {recipient} : {}),
      createdAt,
      expiresAt,
    };
    const prior = (row.connection.invites ?? []).filter(entry => inviteStatus(entry) === 'active' || Date.now() - Date.parse(entry.createdAt) < 7 * 86400_000).slice(-31);
    const next: TokenRecord = {
      ...row,
      connection: {
        ...row.connection,
        invites: [...prior, invite],
        updatedAt: new Date(Math.max(Date.now(), Date.parse(row.connection.updatedAt) + 1)).toISOString(),
      },
    };
    this.write({...config, tokens: config.tokens.map(entry => entry.id === row.id ? next : entry)});
    this.secretValues.add(invite.token);
    return inviteView(invite, origin, roleName);
  }
  revokeInvite(connectionId: string, inviteId: string): {ok: true} {
    this.security?.check();
    const config = this.config(), row = config.tokens.find(entry => entry.id === connectionId && entry.connection);
    if (!row?.connection) throw new HttpError(404, '接入连接不存在');
    const target = (row.connection.invites ?? []).find(entry => entry.id === inviteId);
    if (!target) throw new HttpError(404, '接入邀请不存在');
    if (target.revokedAt) return {ok: true};
    const revokedAt = now();
    const next: TokenRecord = {
      ...row,
      connection: {
        ...row.connection,
        invites: (row.connection.invites ?? []).map(entry => entry.id === inviteId ? {...entry, revokedAt} : entry),
        updatedAt: new Date(Math.max(Date.now(), Date.parse(row.connection.updatedAt) + 1)).toISOString(),
      },
    };
    this.write({...config, tokens: config.tokens.map(entry => entry.id === row.id ? next : entry)});
    return {ok: true};
  }
  private findInviteByToken(config: GatewayConfig, inviteToken: unknown): {row: TokenRecord; invite: InviteRecord} {
    if (typeof inviteToken !== 'string' || !inviteToken) throw new HttpError(404, '接入邀请无效');
    for (const row of config.tokens) {
      for (const invite of row.connection?.invites ?? []) {
        if (equal(inviteToken, invite.token)) return {row, invite};
      }
    }
    throw new HttpError(404, '接入邀请不存在或已失效');
  }
  inspectInvite(inviteToken: unknown, origin: string) {
    const config = this.config(), {row, invite} = this.findInviteByToken(config, inviteToken);
    const status = inviteStatus(invite);
    const connection = LakeGateway.connectionView(row);
    return {
      id: invite.id,
      connectionId: connection.id,
      connectionName: connection.name,
      projectId: connection.projectId,
      ...(connection.routing.mode === 'specialist' ? {roleId: connection.routing.roleId} : {}),
      ...(invite.recipient ? {recipient: invite.recipient} : {}),
      expiresAt: invite.expiresAt,
      status: !connection.enabled && status === 'active' ? 'revoked' as const : status,
      resourceCount: activeResourceGrants(connection).length,
      redeemUrl: `${origin}/api/gateway/invites/${invite.token}/redeem`,
      mcpUrl: `${origin}/api/gateway/mcp`,
      transport: 'streamable-http' as const,
    };
  }
  redeemInvite(inviteToken: unknown, origin: string) {
    this.security?.check();
    const config = this.config(), {row, invite} = this.findInviteByToken(config, inviteToken);
    if (!row.connection) throw new HttpError(404, '接入连接不存在');
    if (!row.connection.enabled) throw new HttpError(403, '接入连接已停用');
    const status = inviteStatus(invite);
    if (status === 'revoked') throw new HttpError(410, '接入邀请已撤销');
    if (status === 'redeemed') throw new HttpError(410, '接入邀请已被使用（单次有效）');
    if (status === 'expired') throw new HttpError(410, '接入邀请已过期');
    const redeemedAt = now();
    const next: TokenRecord = {
      ...row,
      connection: {
        ...row.connection,
        invites: (row.connection.invites ?? []).map(entry => entry.id === invite.id ? {...entry, redeemedAt} : entry),
        updatedAt: new Date(Math.max(Date.now(), Date.parse(row.connection.updatedAt) + 1)).toISOString(),
      },
    };
    this.write({...config, tokens: config.tokens.map(entry => entry.id === row.id ? next : entry)});
    const connection = LakeGateway.connectionView(next);
    return {
      mcpUrl: `${origin}/api/gateway/mcp`,
      transport: 'streamable-http' as const,
      token: row.token,
      connectionId: connection.id,
      connectionName: connection.name,
      projectId: connection.projectId,
      ...(connection.routing.mode === 'specialist' ? {roleId: connection.routing.roleId} : {}),
      ...(invite.recipient ? {recipient: invite.recipient} : {}),
      resourceGrants: activeResourceGrants(connection),
      redeemedAt,
    };
  }
  removeConnection(connectionId: string) { this.connection(connectionId); return this.remove(connectionId); }
  requireConnection(auth: GatewayAuth): GatewayConnection {
    if (!auth.connection) throw new HttpError(403, '此凭据只能使用原专员入口，请创建项目接入连接');
    return auth.connection;
  }
  requireLegacy(auth: GatewayAuth) {
    if (auth.connection) throw new HttpError(403, '项目连接只能使用消息接入接口');
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
    if (row.connection && !row.connection.enabled) throw new HttpError(403, '接入连接已停用');
    return { id: row.id, ...(row.roles?.length ? { roles: [...row.roles] } : {}), ...(row.connection && {connection: LakeGateway.connectionView(row)}) };
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
    this.requireLegacy(auth);
    if (auth.roles && !auth.roles.includes(roleId)) throw new HttpError(403, "此网关凭据未被允许访问该专员");
  }
  scrub(value: string) { for (const secret of this.secretValues) value = value.split(secret).join("[REDACTED]"); return value; }
  close() { this.closed = true; }
}
