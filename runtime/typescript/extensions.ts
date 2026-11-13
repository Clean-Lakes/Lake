import {redactModelValue} from "./model-errors";
import { Client, SSEClientTransport, StreamableHTTPClientTransport, type Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { lstatSync, readFileSync, realpathSync, existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { MCPServerConfig, SkillConfig } from "../../web-agent/shared/contracts";
import { HttpError, id, LakeStore, now } from "./store";
import { digest, text } from "./tasks";
import type { LakeSecurity } from "./security";
import type { Operation } from "./tasks";

type Server = MCPServerConfig & { headers?: Record<string, string>; env?: Record<string, string>; legacyCredentials?: boolean };
type Config = { version: 1; servers: Server[]; skillRoots: string[]; disabledSkills: string[]; removedSkillPaths?:string[]; removedSkills?:string[] };
export type McpBinding = { ProjectID: string; ServerID?: string; Revision: number; Enabled: boolean; ToolNames?: string[];
  LegacyAuthority?: { storeID: string; recoveryEpoch: string } };
export type ExtensionFence = { serverId: string; configurationHash: string; bindingHash: string; catalogHash?: string; local: boolean };
type Connection = { hash: string; client: Client; transport: Transport; generation: string; connecting?: Promise<void> };
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/;
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
const empty = (): Config => ({ version: 1, servers: [], skillRoots: [], disabledSkills: [] });
function privateFile(path: string, maximum = 1000000) {
  const info = lstatSync(path), parent = lstatSync(dirname(path));
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > maximum ||
      !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 ||
      process.platform !== "win32" && (info.uid !== process.getuid?.() || parent.uid !== process.getuid?.()))
    throw new HttpError(409, "扩展配置须为当前用户的私有文件");
}
function readConfig(path: string): Config {
  if (!existsSync(path)) return empty();
  privateFile(path);
  let value: Config; try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new HttpError(409, "扩展配置格式无效"); }
  if (value && value.version === 1) { value.servers ??= []; value.skillRoots ??= []; value.disabledSkills ??= []; }
  if (value.version !== 1 || !Array.isArray(value.servers) || !Array.isArray(value.skillRoots) || !Array.isArray(value.disabledSkills))
    throw new HttpError(409, "扩展配置版本或目录无效");
  for(const key of ['removedSkills','removedSkillPaths'] as const)if(value[key]!==undefined&&(!Array.isArray(value[key])||value[key]!.some(item=>typeof item!=='string')))throw new HttpError(409,'Skill 删除记录格式无效');
  return value;
}
function dictionary(value: unknown, maximum: number, headers = false): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > maximum) throw new HttpError(400, "请求头或环境变量须为字符串对象");
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string" || item.length > 16000 || /[\0\r\n]/.test(item) ||
        (headers ? !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key) || ["host", "content-length", "connection", "mcp-session-id"].includes(key.toLowerCase()) : !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)))
      throw new HttpError(400, "请求头或环境变量字段无效");
  }
  return value as Record<string, string>;
}
function validate(server: Server) {
  if (!identifier.test(server.id)) throw new HttpError(400, "MCP 身份无效");
  text(server.name, "name", 120);
  if (!["stdio", "http", "sse"].includes(server.transport) || typeof server.enabled !== "boolean") throw new HttpError(400, "MCP 连接方式或启用状态无效");
  if (!Number.isSafeInteger(server.timeoutMs) || server.timeoutMs! < 1000 || server.timeoutMs! > 300000) throw new HttpError(400, "超时时间须为 1000～300000 毫秒");
  if (server.workObserver && server.workObserver !== "release-v1") throw new HttpError(400, "不支持的后台观察适配器");
  if (server.protocolVersion && !["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"].includes(server.protocolVersion)) throw new HttpError(400, "不支持的 MCP 协议版本");
  if (!Array.isArray(server.args) || server.args.length > 100 || server.args.some((arg) => typeof arg !== "string" || arg.length > 4000 || arg.includes("\0"))) throw new HttpError(400, "MCP 参数须为字符串数组");
  if (server.transport === "stdio") {
    text(server.command, "command", 2000);
    if (/[\r\n]/.test(server.command)) throw new HttpError(400, "请输入可执行命令，不要使用 Shell 拼接");
  } else {
    let endpoint: URL; try { endpoint = new URL(server.url); } catch { throw new HttpError(400, "请输入完整 HTTP(S) 地址"); }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || server.url.length > 2000)
      throw new HttpError(400, "MCP 地址不能包含认证信息、查询参数或片段");
  }
  if (server.headers) dictionary(server.headers, 40, true);
  if (server.env) dictionary(server.env, 100);
}

export class LakeExtensions {
  private adapters = new Map<string, Connection>();
  private retired = new Set<Promise<unknown>>();
  private secretValues = new Set<string>();
  private closed = false;
  constructor(readonly store: LakeStore, readonly security: LakeSecurity, readonly redact: (value: string) => string) {}
  private get legacyPath() { return join(this.store.home, "secrets/extensions.json"); }
  private get path() { return join(this.store.home, "secrets/extensions-typescript.json"); }
  private config(): Config {
    if (existsSync(this.path)) return readConfig(this.path);
    const original = readConfig(this.legacyPath);
    // Original headers/env stay in their original Dev file. No automatic
    // connection or service execution is performed by settings/catalog reads.
    return { ...original, servers: original.servers.map(({ headers, env, ...server }) => ({ ...server,
      args: server.args ?? [], command: server.command ?? "", url: server.url ?? "", timeoutMs: server.timeoutMs || 30000, legacyCredentials: true })) };
  }
  private write(config: Config) {
    const directory = dirname(this.path); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || process.platform !== "win32" && info.uid !== process.getuid?.()) throw new HttpError(409, "扩展凭据目录无效");
    const body = JSON.stringify(config, null, 2);
    if (Buffer.byteLength(body) >= 1000000) throw new HttpError(413, "扩展配置超过 1 MB");
    const temporary = join(directory, ".extensions-ts-" + id());
    const file = openSync(temporary, "wx", 0o600);
    try { writeFileSync(file, body + "\n"); fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, this.path);
  }
  private raw(serverId: string): Server {
    const server = this.config().servers.find((server) => server.id === serverId);
    if (!server) throw new HttpError(404, "MCP 服务不存在");
    const old = server.legacyCredentials ? readConfig(this.legacyPath).servers.find((item) => item.id === server.id) : undefined;
    const value = { ...server, headers: server.headers ?? old?.headers ?? {}, env: server.env ?? old?.env ?? {} };
    validate(value);
    for (const secret of [...Object.values(value.headers), ...Object.values(value.env)]) if (secret) {
      this.secretValues.add(secret); const bearer = secret.match(/^Bearer\s+(.+)$/i)?.[1]; if (bearer) this.secretValues.add(bearer);
    }
    return value;
  }
  scrub(value: string) { for (const secret of this.secretValues) value = value.split(secret).join("[REDACTED]"); return this.redact(value); }
  scrubLive(value: string) {
    let keep = 0;
    for (const secret of this.secretValues) for (let size = 1; size < secret.length && size <= value.length; size++)
      if (value.endsWith(secret.slice(0, size))) keep = Math.max(keep, size);
    return this.scrub(keep ? value.slice(0, -keep) : value) + (keep ? "[REDACTED]" : "");
  }
  private public(server: Server): MCPServerConfig {
    const { headers, env, legacyCredentials, ...publicServer } = server;
    return { ...publicServer, headersConfigured: Object.keys(headers ?? {}).length > 0, envConfigured: Object.keys(env ?? {}).length > 0 };
  }
  servers() { return { servers: this.config().servers.map((server) => this.public(this.raw(server.id))) }; }
  serverRevision(serverId:string){return digest(this.raw(serverId));}
  patch(serverId:string,input:Record<string,any>){return this.save(serverId,{...this.raw(serverId),...input});}
  save(serverId: string | undefined, input: Record<string, any>) {
    this.security.check();
    const config = this.config(), previous = serverId && config.servers.find((server) => server.id === serverId);
    if (serverId && !previous) throw new HttpError(404, "MCP 服务不存在");
    const server: Server = { ...(previous || {}), id: serverId ?? id(), name: input.name, transport: input.transport, enabled: input.enabled,
      url: input.url ?? "", command: input.command ?? "", args: input.args ?? [], timeoutMs: input.timeoutMs ?? (previous || {}).timeoutMs ?? 30000,
      protocolVersion: input.protocolVersion ?? (previous || {}).protocolVersion ?? "", workObserver: input.workObserver ?? (previous || {}).workObserver ?? "",
      headersConfigured: false, envConfigured: false };
    if (input.clearHeaders === true || input.headers !== undefined) server.headers = input.clearHeaders ? {} : dictionary(input.headers, 40, true);
    if (input.clearEnv === true || input.env !== undefined) server.env = input.clearEnv ? {} : dictionary(input.env, 100);
    validate(server);
    if (!serverId && config.servers.length >= 50) throw new HttpError(400, "最多配置 50 个 MCP 服务");
    config.servers = config.servers.filter((item) => item.id !== server.id).concat(server);
    this.write(config); this.invalidate(server.id);
    return this.public(this.raw(server.id));
  }
  remove(serverId: string) {
    this.security.check(); const config = this.config(); this.raw(serverId);
    config.servers = config.servers.filter((server) => server.id !== serverId); this.write(config); this.invalidate(serverId); return { ok: true };
  }
  import(input: Record<string, any>) {
    this.security.check();
    let root = input;
    if (input.mcpServers !== undefined) { if (Object.keys(input).length !== 1) throw new HttpError(400, "mcpServers 须为唯一顶层字段"); root = input.mcpServers; }
    if (!root || typeof root !== "object" || Array.isArray(root) || !Object.keys(root).length || Object.keys(root).length > 50) throw new HttpError(400, "请输入非空 MCP 配置对象");
    const config = this.config(), names = new Set(config.servers.map((server) => server.name.trim().toLowerCase()));
    const rows: Server[] = [];
    const normalize = (value: unknown) => { if (value !== undefined && typeof value !== "string") throw new HttpError(400, "连接类型须为字符串"); return value?.trim().toLowerCase().replace(/^streamable-http$/, "http"); };
    for (const name of Object.keys(root).sort()) {
      const fields = root[name];
      if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.entries(fields).some(([key, value]) => value == null || !["type", "transport", "command", "args", "url", "headers", "env", "enabled", "timeoutMs", "protocolVersion"].includes(key))) throw new HttpError(400, "服务器包含不支持的字段或空值");
      const primary = normalize(fields.type), alternate = normalize(fields.transport);
      if (primary && alternate && primary !== alternate) throw new HttpError(400, "type 与 transport 不一致");
      if (names.has(name.trim().toLowerCase())) throw new HttpError(409, "存在同名 MCP 服务，请改名后重试"); names.add(name.trim().toLowerCase());
      const server: Server = { id: id(), name: name.trim(), transport: (primary || alternate || (fields.command ? "stdio" : "http")) as Server["transport"], enabled: fields.enabled ?? true,
        command: fields.command ?? "", url: fields.url ?? "", args: fields.args ?? [], timeoutMs: fields.timeoutMs ?? 30000, protocolVersion: fields.protocolVersion === "auto" ? "" : fields.protocolVersion ?? "",
        headers: fields.headers ?? {}, env: fields.env ?? {}, headersConfigured: false, envConfigured: false };
      validate(server); rows.push(server);
    }
    if (rows.length + config.servers.length > 50) throw new HttpError(400, "最多配置 50 个 MCP 服务");
    config.servers.push(...rows); this.write(config); return { servers: rows.map((server) => this.public(server)) };
  }
  private invalidate(serverId: string) {
    const previous = this.adapters.get(serverId); this.adapters.delete(serverId);
    if (previous) { const closing = previous.client.close(); this.retired.add(closing); void closing.finally(() => this.retired.delete(closing)).catch(() => {}); }
    this.store.delete("mcpCatalogs", serverId);
  }
  private async connection(serverId: string, signal: AbortSignal) {
    this.security.check(); if (this.closed) throw new HttpError(409, "扩展宿主已停止");
    if (signal.aborted) throw new HttpError(409, "MCP 调用已取消");
    const server = this.raw(serverId); if (!server.enabled) throw new HttpError(409, "MCP 服务已停用");
    const hash = digest(server);
    let record = this.adapters.get(serverId);
    if (record && record.hash !== hash) { this.invalidate(serverId); record = undefined; }
    if (!record) {
      const transport: Transport = server.transport === "stdio" ? new StdioClientTransport({ command: server.command, args: server.args,
        env: { HOME: this.store.home, PATH: process.env.PATH ?? "", LANG: process.env.LANG ?? "en_US.UTF-8", ...server.env }, cwd: this.store.home, stderr: "ignore" })
        : this.httpTransport(server);
      const client = new Client({ name: "Lake", version: "1" }, { versionNegotiation: { mode: server.protocolVersion === "2026-07-28" ? { pin: server.protocolVersion } : "legacy" } });
      record = { hash, client, transport, generation: id() }; this.adapters.set(serverId, record);
      const expected = record;
      record.connecting = client.connect(transport, { signal, timeout: server.timeoutMs }).then(() => {
        if (server.protocolVersion && client.getNegotiatedProtocolVersion() !== server.protocolVersion) throw new HttpError(409, "MCP 服务未使用指定协议版本");
        if (this.adapters.get(serverId) !== expected || digest(this.raw(serverId)) !== hash || signal.aborted) throw new HttpError(409, "MCP 配置或调用状态已改变");
      }).catch(async () => {
        if (this.adapters.get(serverId) === expected) this.adapters.delete(serverId);
        await client.close().catch(() => {});
        throw new HttpError(502, "无法连接 MCP，请检查地址、命令及认证配置");
      });
    }
    await record.connecting;
    if (signal.aborted || this.adapters.get(serverId) !== record || digest(this.raw(serverId)) !== hash) throw new HttpError(409, "MCP 配置或调用状态已改变");
    return { server, record, hash };
  }
  private httpTransport(server: Server): Transport {
    const endpoint = new URL(server.url);
    const scopedFetch: typeof fetch = async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin !== endpoint.origin) throw new HttpError(403, "MCP 不允许跨站发送认证请求");
      const response = await fetch(input, { ...init, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new HttpError(403, "MCP 不允许认证请求重定向"); }
      return response;
    };
    return server.transport === "sse" ? new SSEClientTransport(endpoint, { requestInit: { headers: server.headers }, fetch: scopedFetch })
      : new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: server.headers }, fetch: scopedFetch,
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 }, onInsufficientScope: "throw", maxStepUpRetries: 0 });
  }
  async test(serverId: string, signal: AbortSignal) {
    const { server, record, hash } = await this.connection(serverId, signal);
    const tools: { name: string; description: string; inputSchema: unknown }[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await record.client.listTools(cursor ? { cursor } : {}, { signal, timeout: server.timeoutMs, cacheMode: "refresh" });
      tools.push(...page.tools.map((tool) => ({ name: tool.name, description: this.scrub(tool.description ?? ""), inputSchema: tool.inputSchema })));
      if (tools.length > 1000 || page.nextCursor && seen.has(page.nextCursor)) throw new HttpError(502, "MCP 目录分页无效或超过 1000 个工具");
      cursor = page.nextCursor; if (cursor) seen.add(cursor);
    } while (cursor);
    if (digest(this.raw(serverId)) !== hash || signal.aborted) throw new HttpError(409, "MCP 配置已变化，目录结果未提交");
    const catalog = { serverId, configurationHash: hash, hash: digest(tools), tools, observedAt: now() };
    this.store.put("mcpCatalogs", serverId, catalog);
    return { server: this.public(server), tools, catalogHash: catalog.hash };
  }
  revision(projectId: string) {
    return digest([this.config(), this.store.get("mcpInheritance", projectId), this.store.list<McpBinding>("mcpBindings").filter((binding) => binding.ProjectID === projectId)]);
  }
  private binding(projectId: string, serverId: string): McpBinding {
    this.store.project(projectId);
    const current = (binding: McpBinding) => {
      if (binding.LegacyAuthority && digest(binding.LegacyAuthority) !== digest(this.security.authority()))
        throw new HttpError(409, "原 MCP 项目选择属于旧恢复纪元，请重新确认当前设置");
      return binding;
    };
    const binding = this.store.get<McpBinding>("mcpBindings", digest([projectId, serverId]));
    if (binding) { current(binding); if (!binding.Enabled) throw new HttpError(403, "此 MCP 服务在当前项目已明确停用"); return binding; }
    const inherited = this.store.get<McpBinding>("mcpInheritance", projectId);
    if (inherited) current(inherited);
    if (inherited?.Enabled) return { ...inherited, ServerID: serverId, Revision: 2 ** 50 + inherited.Revision };
    throw new HttpError(403, "此 MCP 服务未向当前项目启用");
  }
  projectServers(projectId: string, options: Record<string, unknown>) {
    this.store.project(projectId);
    const servers = this.config().servers.flatMap((item) => {
      try {
        const server = this.raw(item.id); if (!server.enabled || server.transport === "stdio" && options.denyLocalExecution === true) return [];
        const binding = this.binding(projectId, server.id);
        this.security.mcp(projectId, "mcp.discover", server.transport === "stdio");
        return [{ id: server.id, name: server.name, transport: server.transport, configurationRevision: digest(server), bindingRevision: digest(binding) }];
      } catch { return []; }
    });
    return { servers };
  }
  inheritance(projectId: string) {
    this.store.project(projectId);
    return { ...(this.store.get<McpBinding>("mcpInheritance", projectId) ?? { ProjectID: projectId, Enabled: false, Revision: 0 }), servers: this.projectServers(projectId, {}).servers.map(({ id, name }) => ({ id, name })) };
  }
  bindings(projectId: string) { this.store.project(projectId); return { bindings: this.store.list<McpBinding>("mcpBindings").filter((binding) => binding.ProjectID === projectId) }; }
  setBinding(projectId: string, serverId: string | undefined, input: Record<string, any>) {
    this.security.check(); this.store.project(projectId); if (serverId) this.raw(serverId);
    if (Object.keys(input).some((key) => !["enabled", "expectedRevision", "actionId", ...(serverId ? ["toolNames"] : [])].includes(key))) throw new HttpError(400, "不支持的项目 MCP 设置字段");
    if (typeof input.enabled !== "boolean" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new HttpError(400, "启用状态与 expectedRevision 无效");
    const action = text(input.actionId, "actionId", 256), actionKey = digest([projectId, serverId ?? "inheritance", action]), requestHash = digest(input);
    const receipt = this.store.get<any>("mcpBindingActions", actionKey);
    if (receipt) { if (receipt.hash !== requestHash) throw new HttpError(409, "MCP 配置动作身份冲突"); return receipt.result; }
    const kind = serverId ? "mcpBindings" : "mcpInheritance", key = serverId ? digest([projectId, serverId]) : projectId;
    const previous = this.store.get<McpBinding>(kind, key);
    if ((previous?.Revision ?? 0) !== input.expectedRevision) throw new HttpError(409, "MCP 项目绑定已变化，请刷新后重试");
    const names = input.toolNames ?? [];
    if (!Array.isArray(names) || names.length > 1000 || names.some((name) => typeof name !== "string") || new Set(names).size !== names.length) throw new HttpError(400, "工具名称列表无效");
    if (serverId && input.enabled) {
      const catalog = this.store.get<any>("mcpCatalogs", serverId);
      if (!catalog || catalog.configurationHash !== digest(this.raw(serverId)) || names.some((name) => !catalog.tools.some((tool: any) => tool.name === name))) throw new HttpError(409, "请先测试当前 MCP 连接并选择实际目录中的工具");
    }
    return this.store.transaction(() => {
      const result: McpBinding = { ProjectID: projectId, ...(serverId ? { ServerID: serverId, ToolNames: names } : {}), Enabled: input.enabled, Revision: input.expectedRevision + 1 };
      this.store.put(kind, key, result); this.store.put("mcpBindingActions", actionKey, { hash: requestHash, result }); return result;
    });
  }
  fence(projectId: string, serverId: string, options: Record<string, unknown>, tool?: string): ExtensionFence {
    this.security.check();
    const server = this.raw(serverId); if (!server.enabled) throw new HttpError(403, "MCP 服务已停用");
    const binding = this.binding(projectId, serverId), local = server.transport === "stdio";
    if (local && options.denyLocalExecution === true || (tool || local) && options.blockUnreferencedAssets === true) throw new HttpError(403, "Pilot 当前权限不允许此 MCP 调用");
    this.security.mcp(projectId, tool ? "mcp.call" : "mcp.discover", local);
    const configurationHash = digest(server), catalog = this.store.get<any>("mcpCatalogs", serverId);
    if (tool && (!catalog || catalog.configurationHash !== configurationHash || !catalog.tools.some((entry: any) => entry.name === tool) || binding.ToolNames && !binding.ToolNames.includes(tool)))
      throw new HttpError(403, "MCP 工具不在当前项目和当前目录中");
    return { serverId, configurationHash, bindingHash: digest(binding), catalogHash: tool ? catalog.hash : undefined, local };
  }
  verifyPins(fence: ExtensionFence, input: any, call = false) {
    if (input.configuration_revision !== fence.configurationHash || input.binding_revision !== fence.bindingHash || call && input.catalog_revision !== fence.catalogHash)
      throw new HttpError(409, "MCP 配置、项目绑定或目录已变化，请重新读取实际目录");
  }
  revalidate(operation: Operation, options: Record<string, unknown>) {
    const fence = this.fence(operation.projectId, operation.mcpServerId!, options, operation.tool === "call_mcp_tool" ? operation.mcpTool : undefined);
    if (fence.configurationHash !== operation.configurationHash || fence.bindingHash !== operation.bindingHash ||
        operation.catalogHash && fence.catalogHash !== operation.catalogHash)
      throw new HttpError(409, "原 MCP 操作的配置、项目绑定或目录已改变");
    if (operation.tool === "list_mcp_tools" && operation.status === "succeeded" &&
        (operation.output as any)?.catalogHash !== this.store.get<any>("mcpCatalogs", operation.mcpServerId!)?.hash)
      throw new HttpError(409, "原 MCP 发现回执与当前目录不匹配");
  }
  async projectTools(projectId: string, input: any, options: Record<string, unknown>, signal: AbortSignal) {
    const before = this.fence(projectId, input.server_id, options); this.verifyPins(before, input);
    const result = await this.test(input.server_id, signal), after = this.fence(projectId, input.server_id, options); this.verifyPins(after, input);
    const binding = this.binding(projectId, input.server_id);
    return { ...result, tools: result.tools.filter((tool) => !binding.ToolNames || binding.ToolNames.includes(tool.name)), configurationRevision: after.configurationHash, bindingRevision: after.bindingHash };
  }
  async call(projectId: string, input: any, options: Record<string, unknown>, signal: AbortSignal) {
    const before = this.fence(projectId, input.server_id, options, input.tool); this.verifyPins(before, input, true);
    if (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments) || Buffer.byteLength(JSON.stringify(input.arguments)) > 100000) throw new HttpError(400, "MCP 参数须为不超过 100 KB 的对象");
    const { record, server } = await this.connection(input.server_id, signal);
    this.verifyPins(this.fence(projectId, input.server_id, options, input.tool), input, true);
    // Exactly one SDK tools/call: no reconnect/reauthorization replay after a
    // dispatched opaque operation. Any transport failure remains unknown.
    const result = await record.client.callTool({ name: input.tool, arguments: input.arguments }, { signal, timeout: server.timeoutMs });
    return redactModelValue(result,text=>this.scrub(text));
  }
  private safeSkillPath(path: string) {
    const value = path.replaceAll("\\", "/").toLowerCase();
    return !/(?:\/\.ssh|\/keychains)(?:\/|$)/.test(value) && !inside(join(this.store.home, "secrets"), path) &&
      !inside(join(homedir(), ".lake"), path) && !/\/\.lake(?:-dev)?\/secrets(?:\/|$)/.test(value);
  }
  skills(workspace = "") {
    const config = this.config(), seen = new Set<string>(), result: SkillConfig[] = [];
    const roots = [...(workspace ? [join(workspace, ".agents/skills"), join(workspace, ".lake/skills")] : []), join(this.store.home, "skills"), ...config.skillRoots];
    for (const root of roots) {
      let actual: string; try { actual = realpathSync(root); } catch { continue; }
      if (!this.safeSkillPath(actual)) continue;
      let candidates: string[];
      try { candidates = existsSync(join(actual, "SKILL.md")) ? [actual] : readdirSync(actual).slice(0, 1000).filter((name) => identifier.test(name)).map((name) => join(actual, name)); }
      catch { continue; }
      for (const directory of candidates) {
        const name = basename(directory); if (!identifier.test(name) || seen.has(name)||config.removedSkills?.includes(name)) continue;
        try {
          const path = realpathSync(join(directory, "SKILL.md")), info = lstatSync(path);
          if (!inside(actual, path) || !this.safeSkillPath(path) || config.removedSkillPaths?.includes(path) || !info.isFile() || info.size > 100000) continue;
          const bytes = readFileSync(path), content = bytes.toString("utf8"); if (!Buffer.from(content).equals(bytes)) continue;
          const description = content.split("\n").map((line) => line.trim()).find((line) => line.startsWith("description:"))?.slice(12).trim().replace(/^["']|["']$/g, "") ?? "";
          const managed = path === join(this.store.home, "skills", name, "SKILL.md");
          result.push({ name, description: [...description].slice(0, 180).join(""), path, source: managed ? "Lake" : workspace && inside(workspace, path) ? "工作区" : "导入目录", managed, enabled: !config.disabledSkills.includes(name) });
          seen.add(name);
        } catch { continue; }
      }
    }
    return { skills: result.sort((a, b) => a.name.localeCompare(b.name)), roots: config.skillRoots, defaultRoot: join(this.store.home, "skills") };
  }
  skill(name: string, workspace = "") {
    if (!identifier.test(name)) throw new HttpError(400, "Skill 名称无效");
    const skill = this.skills(workspace).skills.find((skill) => skill.name === name);
    if (!skill) throw new HttpError(404, "Skill 不存在");
    const content = readFileSync(skill.path, "utf8"); if (Buffer.byteLength(content) > 100000) throw new HttpError(413, "Skill 内容过大");
    return { skill, content: this.scrub(content) };
  }
  saveSkill(name: string, input: Record<string, any>) {
    this.security.check(); if (!identifier.test(name)) throw new HttpError(400, "Skill 名称无效");
    if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw new HttpError(400,'enabled 须为布尔值');
    if (input.content !== undefined) {
      const content = text(input.content, "content", 100000), catalog = this.skills().skills;
      if (input.create === true ? catalog.some((skill) => skill.name.toLowerCase() === name.toLowerCase()) : !catalog.some((skill) => skill.name === name && skill.managed))
        throw new HttpError(409, "仅可编辑 Lake 管理的 Skill，创建时不能覆盖同名项");
      const root = join(this.store.home, "skills"), directory = join(root, name), target = join(directory, "SKILL.md");
      if(input.create===true&&existsSync(target))throw new HttpError(409,'同名 Skill 文件仍存在，不能覆盖保留文件');
      for (const path of [root, directory]) {
        mkdirSync(path, { mode: 0o700, recursive: true }); const info = lstatSync(path);
        if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== "win32" && info.uid !== process.getuid?.()) throw new HttpError(409, "Skill 目录不能是符号链接或其他用户的目录");
      }
      if (existsSync(target) && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())) throw new HttpError(409, "Skill 目标必须是普通文件");
      const temporary = join(directory, ".skill-" + id()), file = openSync(temporary, "wx", 0o600);
      try { writeFileSync(file, content); fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporary, target);
    } else this.skill(name);
    if (input.enabled !== undefined||input.create===true) {
      const config = this.config(); config.disabledSkills = config.disabledSkills.filter((item) => item !== name); if (input.enabled===false) config.disabledSkills.push(name);
      if(input.create===true)config.removedSkills=config.removedSkills?.filter(item=>item!==name);
      this.write(config);
    }
    return { ok: true };
  }
  skillRevision(name:string){const {skill}=this.skill(name);return digest([skill,readFileSync(skill.path,'utf8')]);}
  removeSkill(name:string){
    this.security.check();const {skill}=this.skill(name),config=this.config();
    config.removedSkills=[...new Set([...(config.removedSkills??[]),name])];
    // Older compatible readers ignore tombstones but still honor disabled names.
    config.disabledSkills=[...new Set([...config.disabledSkills,name])];
    if(!skill.managed){
      config.removedSkillPaths=[...new Set([...(config.removedSkillPaths??[]),skill.path])];this.write(config);
      return {name,removed:true,filesDeleted:false,scope:'global',disposition:'unregistered'};
    }
    const root=join(this.store.home,'skills'),directory=join(root,name),trash=join(root,'.trash');
    for(const path of [root,directory]){
      const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink()||process.platform!=='win32'&&info.uid!==process.getuid?.())throw new HttpError(409,'Skill 目录身份已变化');
    }
    mkdirSync(trash,{recursive:true,mode:0o700});const info=lstatSync(trash);
    if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077||process.platform!=='win32'&&info.uid!==process.getuid?.())throw new HttpError(409,'Skill 回收目录必须私有');
    // Persist hiding first so a crash cannot activate a same-named imported Skill.
    this.write(config);const key=id();renameSync(directory,join(trash,key));
    this.store.put('skillTrash',key,{name,at:now()});
    return {name,removed:true,filesDeleted:false,scope:'global',disposition:'archived'};
  }
  skillRoot(path: unknown, remove: boolean) {
    this.security.check(); text(path, "path", 4000);
    const config = this.config(), candidate = resolve(path as string);
    if (remove) config.skillRoots = config.skillRoots.filter((root) => root !== candidate);
    else {
      let actual: string; try { actual = realpathSync(candidate); } catch { throw new HttpError(400, "Skill 目录不存在"); }
      if (!this.safeSkillPath(actual) || !lstatSync(actual).isDirectory()) throw new HttpError(403, "不能将凭据或正式数据目录注册为 Skill 根目录");
      if (!config.skillRoots.includes(actual)) config.skillRoots.push(actual);
      if (config.skillRoots.length > 50) throw new HttpError(400, "最多注册 50 个 Skill 目录");
    }
    this.write(config); return { ok: true };
  }
  async close() { this.closed = true; await Promise.allSettled([...this.adapters.values()].map((record) => record.client.close()).concat([...this.retired] as Promise<void>[])); this.adapters.clear(); }
}
