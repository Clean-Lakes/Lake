import {redactModelValue} from "./model-errors";
import { permissionDefaults } from "../../web-agent/shared/execution-preferences";
import {acknowledgeConversation} from "./conversation-reads";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  readFile,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { isSea } from "node:sea";
import { homedir } from "node:os";
import type {
  ModelDisplayState,
  ModelProvider,
  ProviderModel,
  Resource,
  Project,
  ResourceTreeNode,
  SessionModelState,
} from "../../web-agent/shared/contracts";
import { LakeStore, HttpError, id, now, privateDirectory } from "./store";
import { LakeAgents } from "./agent";
import { LakeNavigation } from "./navigation";
import { LakeResourceNavigation } from "./resource-navigation";
import {LakeResourceManagement} from "./resource-management";
import {LakeResourceImport} from './resource-import';
import type {HexHubImportOptions} from './hexhub-import';
import {PilotConfiguration} from "./pilot-configuration";
import {messageInput} from './message-input';
import {saveChatAttachment, serveChatAttachment} from './chat-attachments';
import {LakeMessageQueue} from './message-queue';
import {LakeWorkflowCatalog} from './workflow-catalog';
import {providerConnection, modelCatalogHeaders} from './provider-connection';
import {reasoningModelIdentity, reasoningSettings, reasoningUpdate} from './reasoning';
import {LakeMagpie} from './magpie';
import {LakeMySQL} from "./mysql";
import {LakeExecution} from "./execution";
import {agentCapabilityCatalog,nativeSearchSupported} from "./capabilities";
import { importLegacyModelSettings } from "./dev-settings";
import {validateRuntimeProfile} from './runtime-profile';
import { LakeSuperagent } from "./superagent";
import { LakeGateway, type GatewayAuth } from "./gateway";
import { GatewayLanIngress } from "./gateway-ingress";
import { LakeEventReceiver } from "./event-receiver";
import { applyLegacyMigration, importLegacySSH, importLegacyMySQL, importLegacyMCP, importLegacyServices, importLegacyWorkflows, loadLegacyView } from "./migration";
import { digest } from "./tasks";
import { LakeSecurity } from "./security";
import { LakeMemory } from "./memory";
import {openClaudeMemIndex} from './claude-mem';
import {LakeServiceResources} from './service-resources';
import { LakeExtensions } from "./extensions";
import {LakeSSH} from "./ssh";
import {LakeJumpServer} from "./jumpserver";
import type {JumpServerEndpoint, JumpServerLogin, JumpServerMount} from "../../web-agent/shared/contracts";
import { LakeTerminals } from "./terminal";
import { commandPolicy } from "../../web-agent/shared/command-policy";
export { previewLegacyMigration, rollbackMigration, importLegacyMySQL, importLegacyMCP, importLegacyServices } from "./migration";
export { LakeMemory } from "./memory";
export {sessionArchiveName, legacySessionArchiveName} from "./session-archive";

declare const __LAKE_VERSION__:string;
export type ServerOptions = { codexHome?:string; home: string; data: string; port: number; staticRoot: string; development?: boolean; production?:boolean; importLegacy?: boolean; importOnly?:boolean; resourceImport?:HexHubImportOptions; grafanaReceiverBase?:string;
  /** Exercise stored automation settings in isolated compatibility fixtures. */
  allowAutomationOverrides?: boolean;
};
const encode = (value: unknown) => JSON.stringify(value);
const equal = (left: string, right: string) => {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
async function canonicalNewPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalNewPath(parent), basename(path));
  }
}
async function body(request: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 24 * 1024 * 1024) throw new HttpError(413, "请求内容过大");
    chunks.push(chunk);
  }
  // Existing Lake DELETE callers intentionally send no JSON body or content type.
  if (!size && request.method === "DELETE") return {};
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json"))
    throw new HttpError(415, "Content-Type must be application/json");
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "无效的 JSON 请求");
  }
}

export {LakeMySQL};

export async function startLakeServer(options: ServerOptions) {
  options = {
    ...options,
    home: resolve(options.home),
    data: resolve(options.data),
    staticRoot: resolve(options.staticRoot),
  };
  options.home = await canonicalNewPath(options.home);
  options.data = await canonicalNewPath(options.data);
  validateRuntimeProfile(options,{production:await canonicalNewPath(resolve(homedir(),'.lake')),development:await canonicalNewPath(resolve(homedir(),'.lake-dev'))});
  if(options.importOnly&&!options.importLegacy)throw new Error('仅导入模式必须同时指定 --migrate-legacy');
  if ([options.home, options.data].some((path) => path === homedir() || path === dirname(path)))
    throw new Error("请为候选指定专用子目录");
  await privateDirectory(options.home);
  await privateDirectory(options.data);
  try {
    if ((await lstat(join(options.data, "runtime.json"))).isSymbolicLink())
      throw new Error("运行记录不能是符号链接");
    const runtime = JSON.parse(await readFile(join(options.data, "runtime.json"), "utf8")) as {
      pid: number;
    };
    if (!Number.isSafeInteger(runtime.pid) || runtime.pid <= 0)
      throw new Error("已有运行记录无效，请核对后再启动");
    try {
      process.kill(runtime.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH")
        throw Object.assign(new Error("stale"), { code: "ENOENT" });
      throw error;
    }
    throw new Error("此 Lake 数据目录已有后端运行，请先正常停止原服务");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Credentials and workspaces belong to Home, even when --data is overridden.
  // Two data directories must not permit concurrent hosts sharing that Home.
  const lockPath = join(options.home, "typescript-host.lock");
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    if (!Number.isInteger(lock.pid) || lock.pid <= 0)
      throw new Error("无效的运行锁，请核对原服务后再启动");
    let running = true;
    try {
      process.kill(lock.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") running = false;
      else throw error;
    }
    if (running) throw new Error("此 Lake 数据目录已有后端运行，请先正常停止原服务");
    await rename(lockPath, lockPath + `.stale-${id()}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lock = await open(lockPath, "wx", 0o600);
  await lock.writeFile(encode({ pid: process.pid }));
  await lock.close();
  let store: LakeStore | undefined;
  let agents: LakeAgents | undefined;
  let superagent: LakeSuperagent | undefined;
  let gateway: LakeGateway | undefined;
  let gatewayIngress: GatewayLanIngress | undefined;
  let eventReceiver: LakeEventReceiver | undefined;
  let security: LakeSecurity | undefined;
  let memory: LakeMemory | undefined;
  let extensions: LakeExtensions | undefined;
  let terminals: LakeTerminals | undefined;
  let ssh:LakeSSH|undefined;
  let jumpServer:LakeJumpServer|undefined;
  let mysql:LakeMySQL|undefined;
  let services:LakeServiceResources|undefined;
  let resourceManagement:LakeResourceManagement|undefined;
  let resourceImport:LakeResourceImport|undefined;
  let execution:LakeExecution|undefined;
  let messageQueue: LakeMessageQueue | undefined;
  let draining = false;
  let closed = false;
  const clients = new Map<string, Set<ServerResponse>>();
  const catalogStreams = new Set<ServerResponse>();
  const catalogChanged=()=>{for(const stream of catalogStreams)stream.write("event: catalog\ndata: {}\n\n");};
  const token = randomBytes(32).toString("hex");
  let origin = "";
  const broadcast = (event: any) => {
    const listeners=clients.get(event.sessionId);
    if(!listeners?.size)return;
    const packet=`id: ${event.seq}\nevent: ${event.type}\ndata: ${encode(event)}\n\n`;
    for (const response of listeners) response.write(packet);
  };
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(encode(value));
  };
  // The exact stdio command for external MCP clients on this install type.
  const gatewayCommand = () => ({
    program: process.execPath,
    script: isSea() ? undefined : process.argv[1],
    home: options.home,
    data: options.data,
  });
  const handleRequest = async (request: IncomingMessage, response: ServerResponse, ingressOrigin?: string) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    try {
      const requestOrigin = ingressOrigin ?? origin;
      const url = new URL(request.url ?? "/", requestOrigin || "http://localhost");
      const path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const method = request.method ?? "GET";
      if (request.headers.origin && request.headers.origin !== origin && (!ingressOrigin || request.headers.origin !== ingressOrigin))
        throw new HttpError(403, "请求来源不受信任");
      if (path[0] !== "api") {
        if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "不支持此请求方法");
        const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        let file = resolve(options.staticRoot, relative);
        if (!file.startsWith(options.staticRoot + sep))
          throw new HttpError(403, "不允许访问此路径");
        try {
          file = await realpath(file);
        } catch (error) {
          if (extname(relative)) throw new HttpError(404, "文件不存在");
          file = join(options.staticRoot, "index.html");
        }
        if (!file.startsWith(options.staticRoot + sep))
          throw new HttpError(403, "不允许访问此路径");
        const types: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
        };
        response.writeHead(200, {
          "Content-Type": types[extname(file)] ?? "application/octet-stream",
          "Cache-Control": "no-store",
        });
        response.end(method === "HEAD" ? undefined : await readFile(file));
        return;
      }
      if (path[1] === 'ingress') {
        response.setHeader('Connection', 'close');
        if (path.length !== 5 || path[2] !== 'v1' || path[3] !== 'grafana')
          throw new HttpError(404, 'Grafana 接收地址不存在');
        if (method !== 'POST') throw new HttpError(405, 'Grafana Webhook 仅接受 POST');
        if (!eventReceiver || draining) throw new HttpError(503, 'Lake 接收端未就绪');
        const receipt = await eventReceiver.receive(path[4]!, request, () => draining);
        json(response, 200, receipt);
        return;
      }
      const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const cookie =
        request.headers.cookie
          ?.split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("lake_session="))
          ?.slice("lake_session=".length) ?? "";
      let gatewayAuth: GatewayAuth | undefined;
      const isGatewayInviteEndpoint = path[1] === "gateway" && path[2] === "invites" && (path.length === 4 && method === "GET" || path.length === 5 && path[4] === "redeem" && method === "POST");
      if (isGatewayInviteEndpoint) {
        if (!gateway) throw new HttpError(503, "服务正在启动");
      } else if (path[1] === "gateway") {
        // External agent clients authenticate with their own scoped token.
        // The UI session token deliberately cannot open the gateway, and the
        // gateway token deliberately cannot open anything else.
        if (!gateway) throw new HttpError(503, "服务正在启动");
        gatewayAuth = gateway.authenticate(bearer);
      } else if (!equal(token, bearer) && !equal(token, cookie)) {
        throw new HttpError(401, "需要 Lake 访问凭据");
      }
      if (!store || !agents || !superagent) throw new HttpError(503, "服务正在启动");
      if (path[1] === 'resources' && path[3] === 'grafana-token' && path.length === 4) {
        if (method !== 'POST') throw new HttpError(405, '不支持此令牌读取方式');
        if (!equal(token, cookie) || request.headers.origin !== origin)
          throw new HttpError(403, '请在已登录的 Lake 工作台查看令牌');
        const input = await body(request);
        if (!services || draining) throw new HttpError(503, 'Lake 服务未就绪');
        json(response, 200, services.revealGrafanaToken(path[2]!, input));
        return;
      }
      if (path[1] === 'settings' && path[2] === 'event-sources') {
        if (!eventReceiver || draining) throw new HttpError(503, 'Lake 接收端未就绪');
        if (path.length === 3 && method === 'POST') {
          json(response, 201, eventReceiver.create(await body(request), origin));
        } else if (path.length === 4 && method === 'PATCH') {
          json(response, 200, eventReceiver.update(path[3]!, await body(request), origin));
        } else if (path[4] === 'deliveries' && method === 'GET' && path.length === 5) {
          const limit = Number(url.searchParams.get('limit') ?? 20);
          json(response, 200, eventReceiver.deliveries(path[3]!, limit, url.searchParams.get('cursor') ?? undefined));
        } else if (path[4] === 'deliveries' && method === 'GET' && path.length === 6) {
          json(response, 200, eventReceiver.delivery(path[3]!, path[5]!));
        } else {
          throw new HttpError(405, '不支持此事件来源操作');
        }
        return;
      }
      if (path[1] === "bootstrap")
        response.setHeader(
          "Set-Cookie",
          `lake_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
        );
      if (path[1] === 'sessions' && path[3] === 'attachments') {
        if (path.length === 4 && method === 'POST') {
          const guard = () => {
            if (draining) throw new HttpError(503, '服务正在退出');
            security!.check();
          };
          guard();
          try { json(response, 201, await saveChatAttachment(store, path[2]!, request, guard)); }
          catch (error) { response.setHeader('Connection', 'close'); throw error; }
        } else if (path.length === 5 && (method === 'GET' || method === 'HEAD')) {
          await serveChatAttachment(store, path[2]!, path[4]!, url.searchParams.get('preview') === '1', method === 'HEAD', response);
        } else throw new HttpError(405, '不支持此附件操作');
        return;
      }
      const data = method === "GET" || method === "HEAD" ? {} : await body(request);
      const cleanup=path[1]==="sessions"&&(path[3]==="host-key"&&data.accept===false||path[3]==="terminals"&&path[5]==="disconnect")||path[1]==="projects"&&path[3]==="superagent"&&path[4]==="stop"&&path.length===5&&method==="POST";
      if (!["GET", "HEAD"].includes(method) && !cleanup && !(path[1] === "superagent" && path[2] === "lifecycle")) security?.check();
      const navigation = new LakeNavigation(store, broadcast);
      const resourceNavigation = new LakeResourceNavigation(store, projectId => store!.list<any>('sessions').some(session => session.projectId === projectId && agents!.isRunning(session.id)));
      await store.refreshModels();
      const validateGatewayScope = (projectId: unknown, routing: unknown) => {
        if (typeof projectId !== 'string' || !projectId) throw new HttpError(400, '请选择所属项目');
        store!.project(projectId);
        const route = routing as {mode?: unknown; roleId?: unknown} | undefined;
        if (route?.mode === 'specialist' && !superagent!.gatewaySpecialists(projectId).specialists.some(role => role.roleId === route.roleId))
          throw new HttpError(400, '指定专员不属于当前项目或已删除');
      };
      const selection = () => store!.modelSelection();
      const catalog = () => ({
        providers: store!.list<ModelProvider>("providers"),
        activeProviderId: selection()?.providerId ?? "",
        activeModelId: selection()?.modelId ?? "",
      });
      const selected = (sessionId?: string) => store!.resolveModel(store!.modelSelection(sessionId));
      const modelSettings = () => {
        const { provider, model } = selected();
        return {
          source: provider ? "settings" : "none",
          configured: !!model,
          url: provider?.baseURL ?? "",
          name: model?.name ?? "",
          protocol: provider?.protocol ?? "openai",
          keyConfigured: provider?.keyConfigured ?? false,
          supportsImageInput: model?.supportsImageInput ?? false,
          ...(store!.magpie?.provider() ? {magpie: {name: store!.magpie!.selectedId()}} : {}),
          ...(provider?.id === 'magpie' ? {managedBy: 'magpie'} : {}),
        };
      };
      const entry = (provider: ModelProvider, model: ProviderModel) => ({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        name: model.name,
        displayName: model.displayName ?? model.name,
        contextWindow: model.contextWindow,
      });
      const available = () => {
        const { provider, model } = selected();
        const entries = store!.modelProviders().filter((provider) => provider.enabled)
          .flatMap((provider) =>
            provider.models.filter((model) => model.enabled).map((model) => entry(provider, model)),
          );
        return {
          models: entries.map((model) => model.name),
          entries,
          activeModelId: model?.id ?? "",
          activeProviderId: provider?.id ?? "",
          ...(provider?.id === 'magpie' ? {source: 'magpie'} : {}),
        };
      };
      const modelDisplay = (sessionId?: string): ModelDisplayState => {
        const { provider, model } = selected(sessionId);
        return {
          modelConfigured: !!model,
          modelName: model?.name ?? null,
          modelId: model && provider ? reasoningModelIdentity(provider, model) : null,
          modelSelection: model && provider ? entry(provider, model) : null,
          supportsImageInput: model?.supportsImageInput ?? false,
        };
      };
      const sessionModel = (sessionId: string | null): SessionModelState | undefined => {
        if (!sessionId) return;
        const choice = store!.sessionModelChoice(sessionId);
        return choice && {...modelDisplay(sessionId), revision: choice.revision};
      };
      const bootstrap = () => ({
        authenticated: true,
        ...modelDisplay(),
        terminalMode: terminals?.supported ? "pty" : "command",
        aiRuntime: "typescript",
        memoryEngine: "layered",
        backendRuntime: "typescript",
        upstreamVersion: "3.17.2",
        recoveryReadOnly: security?.readOnly() ?? true,
      });
      let result: unknown;
      let status = 200;
      if (path[1] === "bootstrap") result = bootstrap();
      else if (path[1] === "memory") {
        if (!memory) throw new HttpError(503, "记忆服务正在启动");
        const projectId = url.searchParams.get("projectId") || undefined;
        if (path.length === 2 && method === "GET") result = { engine: "typescript", scopes: memory.scopes(projectId) };
        else if (path[2] === "scopes" && path[3]) {
          const scope = memory.resolveScope(path[3], projectId);
          if (path.length === 4 && method === "GET") result = memory.view(scope);
          else if (path[4] === "settings" && path.length === 5 && method === "PATCH") result = memory.setSettings(scope, data);
          else if (path[4] === "entries" && path.length === 5 && method === "POST") result = await memory.remember(scope, data);
          else if (path[4] === "entries" && path.length === 6 && method === "PUT") result = await memory.remember(scope, data, path[5]);
          else if (path[4] === "entries" && path.length === 6 && method === "DELETE") result = await memory.forget(scope, path[5], data.expectedRevision);
          else throw new HttpError(405, "不支持此记忆操作");
        } else throw new HttpError(404, "记忆接口不存在");
      }
      else if (path[1] === "jumpserver" && path[2] === "events" && path.length === 3 && method === "GET") {
        response.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-store"});
        response.write("event: catalog\ndata: {}\n\n");
        catalogStreams.add(response);
        response.once("close",()=>catalogStreams.delete(response));
        return;
      }
      else if (path[1] === "catalog") result = store.catalog();
      else if (path[1] === "commands" && path[2] === "policy" && method === "POST") result = commandPolicy(String(data.command ?? ""));
      else if (path[1] === "superagent" && path[2] === "lifecycle") {
        result = {
          pid: process.pid,
          home: options.home,
          dataDirectory: options.data,
          draining,
          backendRuntime: "typescript",
        };
        if (method === "POST") {
          if (data.action !== "drain") throw new HttpError(400, "无效的生命周期操作");
          draining = true;
          status = 202;
          setImmediate(() => void close());
        }
      } else if (path[1] === "settings" && path[2] === "providers") {
        if (path[3] === 'magpie') throw new HttpError(409, 'Magpie 模型和凭据由插件管理，请在 Magpie 中修改连接');
        if (method === "GET" && path.length === 3) result = catalog();
        else if (method === "DELETE" && path.length === 4) {
          store.require<ModelProvider>("providers", path[3]);
          store.delete("providers", path[3]);
          await store.secret(path[3], null);
          result = catalog();
        } else if (method === "POST" && path.length === 5 && ["test", "discover", "detect-capabilities"].includes(path[4])) {
          if (path[4] === "detect-capabilities")
            throw new HttpError(501, "此后端暂不支持自动探测模型能力");
          const existing = store.get<ModelProvider>("providers", path[3]);
          const connection = providerConnection(String(data.protocol ?? existing?.protocol ?? 'openai'), String(data.baseURL ?? existing?.baseURL ?? ''));
          const key = data.apiKey ?? (await store.secret(path[3]));
          const probe = await fetch(connection.modelsURL, {
            headers: modelCatalogHeaders(connection.apiType, key), redirect: 'error',
            signal: AbortSignal.timeout(15000),
          });
          if (!probe.ok) throw new HttpError(502, `模型服务返回 HTTP ${probe.status}`);
          const response = (await probe.json()) as { data?: { id: string; context_window?: number; supported_reasoning_efforts?: string[]; effort?: {supported_levels?: string[]; default_level?: string} }[] };
          if (!Array.isArray(response.data) || response.data.length > 10000 || response.data.some(item => !item || typeof item.id !== 'string' || !item.id || item.id.length > 512))
            throw new HttpError(502, '模型目录返回格式无效');
          const models = [...new Set(response.data.map(item => item.id))];
          const reasoningCapabilities = Object.fromEntries(response.data.flatMap(item => {
            const levels = item.effort?.supported_levels ?? item.supported_reasoning_efforts;
            if (!Array.isArray(levels)) return [];
            const clean = reasoningSettings({id: path[3], protocol: data.protocol ?? existing?.protocol ?? 'openai', baseURL: data.baseURL ?? existing?.baseURL ?? ''} as ModelProvider,
              {id: item.id, name: item.id, reasoningCapability: {levels, default: item.effort?.default_level, source: 'provider'}} as ProviderModel);
            return [[item.id, {levels: clean.levels, ...(clean.default ? {default: clean.default} : {}), source: 'provider'}]];
          }));
          result =
            path[4] === "test"
              ? { ok: true, message: "模型服务连接正常" }
              : {models, reasoningCapabilities, contextLimits: Object.fromEntries(response.data.filter(item => Number.isSafeInteger(item.context_window) && item.context_window! > 0).map(item => [item.id, item.context_window]))};
        } else if (method === "POST" && path.length === 3 || method === "PUT" && path.length === 4) {
          const providerId = path[3] ?? id();
          const previous = store.get<ModelProvider>("providers", providerId);
          const provider: ModelProvider = {
            id: providerId,
            name: String(data.name ?? previous?.name ?? "模型供应商"),
            baseURL: String(data.baseURL ?? previous?.baseURL ?? ""),
            protocol: String(data.protocol ?? previous?.protocol ?? "openai"),
            enabled: data.enabled ?? previous?.enabled ?? true,
            keyConfigured: previous?.keyConfigured ?? false,
            models: data.models ?? previous?.models ?? [],
          };
          const endpoint = new URL(provider.baseURL);
          if (!["http:", "https:"].includes(endpoint.protocol))
            throw new HttpError(400, "模型地址需要 HTTP 或 HTTPS");
          providerConnection(provider.protocol, provider.baseURL);
          if (data.apiKey !== undefined)
            provider.keyConfigured = !!(await store.secret(providerId, data.apiKey));
          store.put("providers", providerId, provider);
          result = { ...catalog(), savedProviderId: providerId };
        } else throw new HttpError(405, "不支持此模型供应商请求");
      } else if (path[1] === "settings" && path[2] === "model") {
        const action = path[3];
        if (path.length > 4 || action && !["test", "select", "state", "available", "capacity"].includes(action)) throw new HttpError(404, "模型接口不存在");
        if (action && method !== (["test", "select"].includes(action) ? "POST" : "GET")) throw new HttpError(405, "不支持此模型请求");
        if (action === "test") result = await agents.testModel(data);
        else if (path[3] === "select") {
          if (typeof data.providerId !== 'string' || typeof data.modelId !== 'string') throw new HttpError(400, '模型不可用');
          store.selectModel(data.providerId, data.modelId);
          result = catalog();
        } else if (path[3] === "state")
          result = {
            ...bootstrap(),
            available: available(),
            providers: catalog(),
            settings: modelSettings(),
            sessionModel: sessionModel(url.searchParams.get('sessionId')),
          };
        else if (path[3] === "available") result = available();
        else if (path[3] === "capacity")
          result = { limit: selected().model?.contextWindow ?? 128000, source: "provider" };
        else if (method === "PUT") {
          const providerId = "custom";
          const name = String(data.name ?? "");
          if (!name.trim()) throw new HttpError(400, "模型名称不能为空");
          providerConnection(String(data.protocol ?? 'openai'), String(data.url ?? ''));
          const provider: ModelProvider = {
            id: providerId,
            name: "自定义模型",
            baseURL: String(data.url ?? ""),
            protocol: String(data.protocol ?? "openai"),
            enabled: true,
            keyConfigured: !!(await store.secret(providerId, data.apiKey)),
            models: [
              {
                id: name,
                name,
                enabled: true,
                supportsImageInput: !!data.supportsImageInput,
                supportsImageOutput: !!data.supportsImageOutput,
                supportsNativeWebSearch:data.supportsNativeWebSearch===true,
                supportsVideoInput:data.supportsVideoInput===true,supportsAudioInput:data.supportsAudioInput===true,supportsPdfInput:data.supportsPdfInput===true,
              },
            ],
          };
          store.put("providers", providerId, provider);
          store.selectModel(providerId, name);
          result = modelSettings();
        } else if (method === "DELETE") {
          store.delete("settings", "modelSelection");
          store.delete('settings', 'nativeModelSelection');
          result = modelSettings();
        } else if (method === "GET" && path.length === 3) result = modelSettings();
        else throw new HttpError(405, "不支持此模型请求");
      } else if (path[1] === "projects" && path[3] === "security" && ["mcp-inheritance", "mcp-bindings"].includes(path[4])) {
        if (path[4] === "mcp-inheritance" && path.length === 5) {
          if (method === "GET") result = extensions!.inheritance(path[2]);
          else if (method === "PUT") result = extensions!.setBinding(path[2], undefined, data);
          else throw new HttpError(405, "不支持此项目 MCP 继承操作");
        } else if (path[4] === "mcp-bindings" && path.length === 5 && method === "GET") result = extensions!.bindings(path[2]);
        else if (path[4] === "mcp-bindings" && path.length === 6 && method === "PUT") result = extensions!.setBinding(path[2], path[5], data);
        else throw new HttpError(405, "不支持此项目 MCP 绑定操作");
      } else if (path[1] === "projects" && path.length === 4 && path[3] === "session-navigation" && method === "POST")
        result = navigation.move(path[2], data);
      else if(path[1]==="agent-capabilities"&&path.length===2&&method==="GET")result={upstreamVersion:"3.17.2",tools:agentCapabilityCatalog({nativeWebSearch:nativeSearchSupported(selected().provider?.protocol,selected().model?.supportsNativeWebSearch)}),resourceExecution:{local:process.platform==="darwin",ssh:!!execution}};
      else if (path[1] === "projects" && path.length === 2 && method === "POST")
        result = store.createProject(String(data.name ?? ""));
      else if (path[1] === "projects" && path.length === 3 && method === "PATCH")
        result = store.renameProject(path[2], String(data.name ?? ""));
      else if (path[1] === "projects" && path[3] === "sessions" && method === "POST")
        result = store.createSession(path[2]);
      else if (path[1] === "projects" && path[3] === "resource-tree" && path.length === 4) {
        if (method !== 'POST') throw new HttpError(405, '不支持此资源目录请求');
        result = resourceNavigation.edit(path[2], data);
      }
      else if (path[1] === "projects" && path[3] === "jumpserver") {
        const projectId = path[2], cancel = new AbortController(), abort = () => cancel.abort();
        response.once("close", abort);
        try {
          if (path.length === 4 && method === "GET") result = {binding:jumpServer!.view(projectId)};
          else if (path.length === 4 && method === "PUT") result = await jumpServer!.save(projectId,data as JumpServerMount,cancel.signal);
          else if (path.length === 4 && method === "PATCH") result = jumpServer!.updateEndpoint(projectId,data as JumpServerEndpoint);
          else if (path.length === 4 && method === "DELETE") { await jumpServer!.remove(projectId,data.id,data.revision); result = {}; }
          else if (path.length === 5 && path[4] === "preview" && method === "POST") result = await jumpServer!.preview(projectId,data as JumpServerLogin,cancel.signal);
          else if (path.length === 5 && path[4] === "sync" && method === "POST") result = await jumpServer!.sync(projectId);
          else throw new HttpError(405, "不支持此 JumpServer 绑定操作");
        } finally { response.off("close", abort); }
      }
      else if(path[1]==='projects'&&path.length===4&&['resource-import-preview','resource-import'].includes(path[3])){
        if(method!=='POST')throw new HttpError(405,'不支持此资源导入请求');
        const cancel=new AbortController(),abort=()=>cancel.abort();response.on('close',abort);
        try{
          result=path[3]==='resource-import-preview'?await resourceImport!.preview(path[2],data,cancel.signal):await resourceImport!.commit(path[2],data,cancel.signal);
          if(path[3]==='resource-import')status=201;
        }finally{response.off('close',abort);}
      }
      else if (path[1] === "projects" && path[3] === "resources") {
        store.project(path[2]);
        if(path.length===5&&path[4]==='test'&&method==='POST'){
          const cancel=new AbortController(),abort=()=>cancel.abort();response.on('close',abort);
          try{result=await services!.test(path[2],data,cancel.signal);}finally{response.off('close',abort);}
        }
        else if(path.length!==4)throw new HttpError(404,'资源接口不存在');
        else if (method === "GET")
          result = store.catalog().resources.filter((resource) => resource.projectId === path[2]);
        else if(method==='POST')result=resourceManagement!.create(path[2],data);
        else throw new HttpError(405,'不支持此资源请求');
      } else if (path[1] === 'projects' && path[3] === 'external-agents') {
        store.project(path[2]);
        const registry=agents.external.registry;
        if(path.length===4&&method==='GET')result={agents:await agents.external.status(path[2])};
        else if(path.length===5&&method==='PUT')result=await registry.save(path[2],path[4],data);
        else if(path[4]==='antigravity'&&path[5]==='google-login'){
          if(draining)throw new HttpError(503,'Lake 正在退出');
          const cancel=new AbortController(),abort=()=>cancel.abort();
          response.on('close',abort);
          try{
            if(path.length===6&&method==='POST')
              result=await agents.external.startGoogleLogin(path[2],data.expectedRevision,cancel.signal);
            else if(path.length===7&&method==='POST')
              result=await agents.external.completeGoogleLogin(path[2],path[6],data.code,cancel.signal);
            else if(path.length===7&&method==='DELETE')
              result=await agents.external.cancelGoogleLogin(path[2],path[6]);
            else throw new HttpError(405,'不支持此 Google 登录操作');
          }finally{response.off('close',abort);}
        }
        else if(path.length===6&&method==='POST'&&['probe','install','prepare'].includes(path[5])){
          const cancel=new AbortController(),abort=()=>cancel.abort();response.on('close',abort);
          const timeout=setTimeout(abort,path[5]==='probe'?90000:300000);
          try{result=path[5]==='prepare'?await agents.external.prepare(path[2],path[4],data,cancel.signal):path[5]==='probe'?await agents.external.probe(path[2],path[4],cancel.signal):await registry.install(path[2],path[4],data.npmPath,cancel.signal);}
          finally{clearTimeout(timeout);response.off('close',abort);}
        }else throw new HttpError(405,'不支持此外部 Agent 请求');
      } else if (path[1] === "projects" && path[3] === "watchdog" && path.length === 4) {
        store.project(path[2]);
        if (method === "GET") result = {mode:superagent.watchdog.mode(path[2])};
        else if (method === "PUT") result = superagent.setWatchdogMode(path[2],data.mode);
        else throw new HttpError(405,"不支持此巡检请求");
      } else if (path[1] === "projects" && path[3] === "superagent") {
        store.project(path[2]);
        if(path.length===5&&path[4]==='specialists'&&method==='POST'){
          await agents.prepareRedaction();
          if(draining)throw new HttpError(503,'服务正在退出');
          result=superagent.createSpecialist(path[2],data);
          status=201;
          catalogChanged();
        }
        else if(path[4]==='groups'&&method==='POST'&&(path.length===5||path.length===7&&path[6]==='messages')){
          await agents.prepareRedaction();
          if(draining)throw new HttpError(503,'服务正在退出');
          if(path.length===5){
            result=superagent.conversations.createGroup(path[2],data);
            superagent.ensure(path[2]);
            status=201;
          }else{
            result=await superagent.sendGroupMessage(path[2],path[5],data);
            status=202;
          }
        }
        else if(path.length===5&&path[4]==="stop"&&method==="POST"){
          const target=String(data.routerSessionId??'');
          if(target&&superagent.workspace(path[2]).project.routerSessionId===target)messageQueue!.pauseProject(path[2]);
          else if(superagent.conversations.group(path[2],target))messageQueue!.pause(target);
          else throw new HttpError(409,'Pilot 工作区身份已变化');
          result=await superagent.stopWorkspace(path[2],target);
        }
        else if (path.length === 6 && path[4] === "specialists" && method === "DELETE")
          result = await superagent.deleteRole(path[2], path[5], data.revision);
        else if (path.length === 7 && path[4] === 'specialists' && path[6] === 'execution' && method === 'PUT')
          result = superagent.setRoleExecution(path[2],path[5],data);
        else if (path.length >= 7 && path[4] === 'specialists' && path[6] === 'mcp') {
          const project = store.project(path[2]);
          const roleInfo = superagent.gatewaySpecialists(path[2]).specialists.find(item => item.roleId === path[5]);
          if (!roleInfo) throw new HttpError(404, '专员不存在或已删除');
          const specialistChannel = superagent.workspace(path[2]).channels?.find(item => item.roleId === path[5]);
          const projectResources = store.catalog().resources.filter(resource => resource.projectId === path[2]);
          const resourceIds = new Set(projectResources.map(resource => resource.id));
          const readMcpState = async () => {
            const gatewayOrigin = await gatewayIngress!.ensure(origin);
            const connection = gateway!.specialistConnection(path[2], path[5]);
            return {
              projectId: path[2],
              projectName: project.name,
              roleId: roleInfo.roleId,
              roleName: roleInfo.name,
              ...(specialistChannel?.avatarId ? { avatarId: specialistChannel.avatarId } : {}),
              connection: connection ? { ...connection, lastReceivedAt: superagent!.lastGatewayMessageAt(connection.id) } : null,
              resources: projectResources.map(resource => ({
                id: resource.id,
                name: resource.name,
                kind: resource.kind,
                status: resource.status,
                host: resource.ssh?.host ?? (typeof resource.settings?.host === 'string' ? resource.settings.host : typeof resource.settings?.endpoint === 'string' ? resource.settings.endpoint : typeof resource.settings?.baseUrl === 'string' ? resource.settings.baseUrl : undefined),
              })),
              invites: connection ? gateway!.listInvites(connection.id, gatewayOrigin, roleInfo.name) : [],
              remoteEndpoint: `${gatewayOrigin}/api/gateway/mcp`,
            };
          };
          if (path.length === 7 && method === 'GET') {
            result = await readMcpState();
          } else if (path.length === 8 && path[7] === 'grants' && method === 'PUT') {
            const rawGrants = Array.isArray(data.resourceGrants) ? data.resourceGrants : [];
            for (const entry of rawGrants) {
              const rid = typeof entry?.resourceId === 'string' ? entry.resourceId : '';
              if (!resourceIds.has(rid)) throw new HttpError(400, '授权资源不属于当前项目');
            }
            gateway!.saveSpecialistGrants({
              projectId: path[2],
              roleId: path[5],
              roleName: roleInfo.name,
              resourceGrants: rawGrants,
              ...(data.enabled !== undefined ? { enabled: Boolean(data.enabled) } : {}),
              ...(typeof data.expectedUpdatedAt === 'string' ? { expectedUpdatedAt: data.expectedUpdatedAt } : {}),
            });
            result = await readMcpState();
          } else if (path.length === 8 && path[7] === 'invites' && method === 'POST') {
            const connection = gateway!.specialistConnection(path[2], path[5]);
            if (!connection) throw new HttpError(409, '请先确认资源授权，再生成接入邀请');
            const gatewayOrigin = await gatewayIngress!.ensure(origin);
            const invite = gateway!.createInvite(connection.id, data, gatewayOrigin, roleInfo.name);
            status = 201;
            result = { invite, state: await readMcpState() };
          } else if (path.length === 9 && path[7] === 'invites' && method === 'DELETE') {
            const connection = gateway!.specialistConnection(path[2], path[5]);
            if (!connection) throw new HttpError(404, '接入连接不存在');
            gateway!.revokeInvite(connection.id, path[8]);
            result = await readMcpState();
          } else if (path.length === 8 && path[7] === 'disconnect' && method === 'POST') {
            const connection = gateway!.specialistConnection(path[2], path[5]);
            if (!connection) throw new HttpError(404, '接入连接不存在');
            gateway!.updateConnection(connection.id, { enabled: false, expectedUpdatedAt: connection.updatedAt });
            result = await readMcpState();
          } else throw new HttpError(405, '不支持此专员 MCP 接入操作');
        }
        else if (path.length !== 4) throw new HttpError(404, "Super-agent 接口不存在");
        else if (method === "GET") result = superagent.workspace(path[2]);
        else if (method === "POST") result = superagent.ensure(path[2]);
        else throw new HttpError(405, "不支持此请求方法");
      } else if (path[1] === "projects" && ["pilot", "sre"].includes(path[3])) {
        store.project(path[2]);
        result = { enabled: false, autoAdvance: false, revision: 0 };
        if (method !== "GET") throw new HttpError(501, "Pilot 与长期专员调度尚未迁移完成");
      } else if (path[1] === "projects" && path[3] === 'workflows') {
        store.project(path[2]); await agents.prepareRedaction(); const workflows = new LakeWorkflowCatalog(store, value => agents!.redact(value));
        if (path.length === 4 && method === 'GET') result = workflows.list(path[2]);
        else if (path.length === 4 && method === 'POST') result = workflows.save(path[2], data);
        else if (path.length === 5 && method === 'PUT') result = workflows.save(path[2], data, path[4]);
        else if (path.length === 5 && method === 'DELETE') result = workflows.remove(path[2], path[4], data.version);
        else if (path.length === 6 && path[5] === 'run' && method === 'POST') throw new HttpError(501, '工作流只读执行和冻结权限绑定尚未接入，模板已保留，未启动运行');
        else throw new HttpError(405, '不支持此工作流请求');
      } else if (path[1] === "projects" && path[3] === "memory-settings") {
        result = {
          projectId: path[2],
          useEnabled: false,
          extractionEnabled: false,
          epoch: 0,
          revision: 0,
          settingsRevision: 0,
          publishedRevision: 0,
        };
        if (method !== "GET") throw new HttpError(501, "新记忆流水线尚未接入");
      } else if (path[1] === 'resources' && path[3] === 'grafana-webhook' && path[4] === 'inject' && path.length === 5) {
        if (method !== 'POST') throw new HttpError(405, '不支持此 Grafana 注入方法');
        if (!eventReceiver || draining) throw new HttpError(503, 'Lake 接收端未就绪');
        const cancel = new AbortController(), abort = () => cancel.abort();
        response.on('close', abort);
        try {
          result = await services!.injectGrafanaWebhook(path[2], data, eventReceiver,
            {origin, receiverBase: options.grafanaReceiverBase}, cancel.signal);
        } finally {
          response.off('close', abort);
        }
      } else if (path[1] === 'resources' && path[3] === 'grafana-webhook' && path.length === 4) {
        if (!eventReceiver || draining) throw new HttpError(503, 'Lake 接收端未就绪');
        if (method === 'GET') result = {source: eventReceiver.resourceSource(path[2], origin)};
        else if (method === 'POST') {
          if (Object.keys(data).length) throw new HttpError(400, 'Webhook 通过当前 Grafana 资源绑定');
          result = eventReceiver.bindResource(path[2], origin);
          status = 201;
        } else throw new HttpError(405, '不支持此 Grafana Webhook 操作');
      } else if (path[1] === 'resources' && path[3] === 'grafana-read' && path.length === 4) {
        if (method !== 'POST') throw new HttpError(405, '不支持此 Grafana 查询方法');
        if (draining) throw new HttpError(503, 'Lake 正在退出');
        const resource = store.require<Resource>('resources',path[2]);
        const {revision, ...input} = data;
        const cancel = new AbortController(), abort = () => cancel.abort();
        response.on('close',abort);
        try {
          result = await services!.readGrafana(resource.projectId,resource.id,revision,input as import('../../web-agent/shared/contracts').GrafanaReadInput,cancel.signal);
        } finally {
          response.off('close',abort);
        }
      } else if (path[1] === "resources") {
        const resource = store.require<Resource>("resources", path[2]);
        if (path[3] === "jumpserver-accounts" && path.length === 4 && resource.jumpServer) {
          const cancel = new AbortController(), abort = () => cancel.abort();
          response.once("close", abort);
          try {
            if (method === "GET") result = {accounts:await jumpServer!.accounts(resource,cancel.signal)};
            else if (method === "PUT") result = await jumpServer!.choose(resource,data.accountId,cancel.signal);
            else throw new HttpError(405,"不支持此账号操作");
          } finally { response.off("close", abort); }
        }
        else if (path[3] === "terminal-context" && path.length === 4 && method === "POST") result = terminals!.context(resource.id);
        else if (path[3] === "terminals" && method === "GET" && path.length === 4) result = { terminals: terminals!.resourceTerminals(resource.id) };
        else if (path[3] === "terminals" && method === "DELETE" && (path.length === 4 || path.length === 5)) {
          const entries = terminals!.resourceTerminals(resource.id).filter((terminal) => path.length === 4 || terminal.id === path[4]);
          for (const terminal of entries) await terminals!.disconnect(terminal.sessionId, terminal.id);
          result = { closed: entries.length };
        }
        else if(method==='PATCH'&&path.length===3)result=resourceManagement!.update(resource,data);
        else if (method === "GET" && path.length === 3) result = {...resource,configurationRevision:store.get<number>('resourceRevisions',resource.id)??1};
        else throw new HttpError(path.length === 3 ? 405 : 404, "资源接口不存在或不支持此请求方法");
      } else if (path[1] === "sessions") {
        const sessionId = path[2];
        const session = store.session(sessionId);
        const group=session.workspaceRole==='group'?superagent.conversations.group(session.projectId,sessionId):undefined;
        if(session.workspaceRole==='conversation'&&!['GET','HEAD'].includes(method))throw new HttpError(409,'对话回应会话由宿主管理，请在 Pilot 或专员频道继续');
        if(session.workspaceRole==='group'&&!group)throw new HttpError(404,'当前项目找不到该群组');
        if(group&&!store.get('superProjects',session.projectId))superagent.ensure(session.projectId);
        if (session.workspaceRole === "legacy" && !["GET", "HEAD"].includes(method) && !(path[3] === "presentation" || path.length === 3 && method === "PATCH"))
          throw new HttpError(409, "旧 Go 会话为只读档案；请在 Pilot 中提出新的明确要求，历史任务与操作不会重放");
        if (method === "GET" && (path[3] === "snapshot" || path[3] === "ai")) {
          await agents.prepareRedaction(sessionId);
          await loadLegacyView(store, sessionId, (value) => agents!.redact(value));
        }
        if (path[3] === "messages-read" && path.length === 4 && method === "PUT") result = acknowledgeConversation(store, sessionId, data.cursor);
        else if (path[3] === "executions" && path.length === 6 && path[5] === "interrupt" && method === "POST") { result = execution!.interrupt(sessionId, path[4], data.generation); status = 202; }
        else if (["operation-reconciliation", "operator-effect-review"].includes(path[3]) && path.length===5) {
          throw new HttpError(410, "任务核实与验收流程已移除；原操作记录保留，无需提交核实结果");
        }
        else if (path[3] === "host-key" && path.length===4 && method==="POST")result=ssh!.decide(sessionId,data);
        else if (path[3] === "terminals") {
          if (path.length === 4 && method === "POST") { await agents.prepareRedaction(); extensions!.servers(); result = await terminals!.open(sessionId, data); status = 201; }
          else if (path.length === 5 && path[4] === "available" && method === "GET") result = terminals!.available(sessionId);
          else if (path.length === 6 && path[5] === "history" && method === "GET") result = terminals!.history(sessionId, path[4], url.searchParams.get("outputOnly") === "1");
          else if (path.length === 6 && method === "POST") {
            const terminalId = path[4];
            switch (path[5]) {
              case "adopt": result = terminals!.adopt(sessionId, terminalId, data); break;
              case "control": result = terminals!.control(sessionId, terminalId, data.holder); break;
              case "input": result = terminals!.input(sessionId, terminalId, data.data); status = 202; break;
              case "resize": result = terminals!.resize(sessionId, terminalId, data.cols, data.rows); break;
              case "commands": result = terminals!.command(sessionId, terminalId, data); status = 202; break;
              case "interrupt": result = terminals!.interrupt(sessionId, terminalId); status = 202; break;
              case "interrupt-command": result = terminals!.interrupt(sessionId, terminalId, data); status = 202; break;
              case "disconnect": result = await terminals!.disconnect(sessionId, terminalId); break;
              default: throw new HttpError(501, "此终端能力仍在迁移中");
            }
          } else throw new HttpError(405, "不支持此终端请求");
        } else if (path[3] === "channel") {
          if (path.length === 5 && path[4] === "tasks" && method === "GET") result = superagent.channelTasks(sessionId);
          else if (path.length === 5 && path[4] === "read" && method === "PUT") result = superagent.readCompletion(sessionId, data.cursor);
          else if (path.length !== 4) throw new HttpError(404, "频道接口不存在");
          else if (method === "GET") { await agents.prepareRedaction(); result = await superagent.channelPage(sessionId, url.searchParams.get("cursor") ?? ""); }
          else if (method === "POST" && data.action === "stop") {messageQueue!.pause(sessionId);result = await superagent.stopChannel(sessionId);}
          else throw new HttpError(405, "不支持此请求方法");
        } else if (path.length === 4 && path[3] === "presentation") {
          if (method !== "PUT") throw new HttpError(405, "不支持此请求方法");
          result = navigation.presentation(sessionId, data);
        } else if (path[3] === "snapshot" && path.length === 4 && method === "GET") {
          const snapshot = store.snapshot(sessionId);
          snapshot.ai = store.viewPage(sessionId);
          snapshot.model = sessionModel(sessionId);
          result = superagent.decorate(snapshot,url.searchParams.get("taskId")??undefined);
        }
        else if (path[3] === "events" && path.length === 4 && method === "GET") {
          const after = Number(url.searchParams.get("after") ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, "无效的事件游标");
          const workers = [...new Set(url.searchParams.getAll('worker'))];
          if (workers.length&&!superagent.allowsPilotWorkers(session.projectId,sessionId,workers))
            throw new HttpError(404,'此专员会话不在当前 Pilot 对话');
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          });
          response.write(": connected\n\n");
          for (const event of store.events(sessionId, after))
            response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${encode(event)}\n\n`);
          const subscriptions=[sessionId,...workers];
          for (const id of subscriptions) {
            let set=clients.get(id);
            if(!set)clients.set(id,set=new Set());
            set.add(response);
          }
          // Workers catch up with their own snapshots so their cursors remain
          // independent of the Router cursor in the URL.
          if(workers.length)response.write('event: worker-subscriptions\ndata: {}\n\n');
          const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000);
          response.once("close", () => {
            clearInterval(heartbeat);
            for(const id of subscriptions){
              const set=clients.get(id);
              set?.delete(response);
              if(!set?.size)clients.delete(id);
            }
          });
          return;
        } else if (path[3] === "completion" && path.length === 4 && method === "POST") {
          if (draining) throw new HttpError(503, "服务正在退出");
          const cancel = new AbortController(), abort = () => cancel.abort();
          response.on('close', abort);
          if (response.destroyed) abort();
          try { result = await agents.completeDraft(sessionId, data, cancel.signal); }
          finally { response.off('close', abort); }
        } else if (path[3] === "messages" && path.length === 4 && method === "POST") {
          if (draining) throw new HttpError(503, "服务正在退出");
          if (data.images?.length) throw new HttpError(501, '图片可以作为普通附件发送');
          if (data.terminalReuse) throw new HttpError(501, '终端交接尚未接入，未发送此消息');
          await agents.prepareRedaction(sessionId);
          const original = String(data.text ?? '');
          const input = messageInput(store, sessionId, agents.redact(original), data);
          const text = !original.trim() && input.files?.length ? '请查看随消息附上的文件。' : original;
          if(data.assignment!==undefined){
            if(data.enqueue===true)throw new HttpError(400,'分配新任务须直接接单，不能作为普通待发送消息入队');
            result=await superagent.send(sessionId,text,data.taskId,data.ignoreProjectMemory===true,input,data.assignment);
          }
          else if (data.enqueue === true || !group && session.workspaceRole !== 'router' && messageQueue!.get(sessionId).items.length) result = messageQueue!.enqueue(sessionId, agents.redact(text), {...data, ...input});
          else result = await superagent.send(sessionId, text, data.taskId, data.ignoreProjectMemory === true, input);
          status = 202;
        } else if (path[3] === "message-queue") {
          if (path.length !== 4) throw new HttpError(404, '消息队列接口不存在');
          if (method === 'GET') result = messageQueue!.get(sessionId);
          else if (method === 'POST') result = messageQueue!.mutate(sessionId, data);
          else throw new HttpError(405, '不支持此消息队列请求');
        } else if (path[3] === "ai") {
          if (path.length > 5) throw new HttpError(404, "会话接口不存在");
          const reads = [undefined, "snapshot", "options", "references", "plans"];
          if (method !== (reads.includes(path[4]) || path[4] === "reasoning" && method === "GET" ? "GET" : "POST"))
            throw new HttpError(405, "不支持此会话请求方法");
          switch (path[4]) {
            case 'plans': result = superagent.plans(sessionId); break;
            case 'extractPreset': result = await agents.extractPreset(sessionId); break;
            case 'executePlan': result = superagent.executePlan(sessionId, data.planId); break;
            case 'mode': {
              if (!['default', 'plan'].includes(data.mode)) throw new HttpError(400, '会话模式无效');
              if (session.workspaceRole === 'worker') throw new HttpError(409, '当前任务的计划模式已冻结，请在 Pilot 或专员频道设置后续任务模式');
              if (superagent.messageQueueBusy(sessionId) || messageQueue!.get(sessionId).items.length) throw new HttpError(409, '请先结束本轮并处理待发送消息，再切换模式');
              session.options = {...session.options, conversationMode: data.mode}; store.put('sessions', sessionId, session);
              const event = store.event(sessionId, 'session', {conversationMode: data.mode}); broadcast(event); result = {mode: data.mode, cursor: event.seq}; break;
            }
            case undefined:
            case "snapshot":
              result = superagent.routingView(sessionId,agents.executionView(sessionId, store.viewPage(sessionId, url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined)));
              break;
            case "options":
              result = { ...session.options, ...superagent.inheritedExecutionPreferences(sessionId), agentRuntime: "typescript" };
              break;
            case "configure": {
              const switches=Object.entries(data).filter(([key])=>Object.hasOwn(permissionDefaults,key));
              if (!group && switches.length && superagent.inheritedExecutionPreferences(sessionId))
                throw new HttpError(409, "专员统一使用 Pilot 的执行偏好，请在 Pilot 中修改权限");
              if(switches.some(([,value])=>typeof value!=='boolean'))throw new HttpError(400,'执行偏好必须是开启或关闭');
              const owner=group&&switches.length?store.session(superagent.ensure(session.projectId).routerSessionId):undefined;
              if (agents.isRunning(sessionId)||owner&&agents.isRunning(owner.id))
                throw new HttpError(409, "请先停止当前任务再修改配置");
              const localOptions=owner?Object.fromEntries(Object.entries(data).filter(([key])=>!Object.hasOwn(permissionDefaults,key))):data;
              session.options = { ...session.options, ...localOptions, agentRuntime: "typescript" };
              store.transaction(()=>{
                store!.put('sessions',sessionId,session);
                if(owner)store!.put('sessions',owner.id,{...owner,options:{...owner.options,...Object.fromEntries(switches)}});
              });
              if(owner)broadcast(store.event(owner.id,'session'));
              result = { ...session.options, ...superagent.inheritedExecutionPreferences(sessionId), agentRuntime: "typescript" };
              break;
            }
            case "abort":
              messageQueue!.pause(sessionId);
              await agents.abort(sessionId);
              result = {};
              break;
            case "decision":
              if (!superagent.decision(sessionId, data)) agents.decision(sessionId, String(data.id), data.accept === true);
              result = {};
              break;
            case "answer":
            case "questionReply":
              superagent.answer(sessionId, data);
              result = {};
              break;
            case "workControl":
              result = await superagent.control(sessionId, data);
              break;
            case "references":
              result = (store.get<{resourceIds: string[]}>('sessionResourceReferences', sessionId)?.resourceIds ?? [])
                .filter(id => store!.catalog().resources.some(resource => resource.id === id && resource.projectId === session.projectId));
              break;
            case 'clearReferences':
              if (superagent.messageQueueBusy(sessionId)) throw new HttpError(409, '请先结束当前回复再清除资源访问记忆');
              store.delete('sessionResourceReferences', sessionId); result = {}; break;
            case "model": {
              if (session.workspaceRole === 'worker' || session.workspaceRole === 'role')
                throw new HttpError(409, '专员模型由专员配置管理');
              if (typeof data.providerId !== 'string' || typeof data.modelId !== 'string')
                throw new HttpError(400, '请选择已启用的供应商和模型');
              if (superagent.modelChangeBusy(sessionId) || messageQueue!.get(sessionId).items.length)
                throw new HttpError(409, '请先结束本轮并处理待发送消息，再切换模型');
              const event = store.selectSessionModel(sessionId, {providerId: data.providerId, modelId: data.modelId});
              if (event) broadcast(event);
              result = sessionModel(sessionId);
              break;
            }
            case "reasoning": {
              const {provider, model} = selected(sessionId);
              if (method === 'POST') {
                if (session.workspaceRole === 'worker') throw new HttpError(409, '当前任务的模型选项已冻结，请在 Pilot 或专员频道设置后续任务');
                if (superagent.modelChangeBusy(sessionId) || messageQueue!.get(sessionId).items.length) throw new HttpError(409, '请先结束本轮并处理待发送消息，再设置思考级别');
                session.options = {...session.options, ...reasoningUpdate(provider, model, data)};
                store.put('sessions', sessionId, session);
                broadcast(store.event(sessionId, 'session'));
              }
              result = reasoningSettings(provider, model, session.options);
              break;
            }
            default:
              throw new HttpError(501, "此会话操作尚未迁移完成");
          }
        } else if (method === "PATCH" && path.length === 3) {
          session.title = String(data.title ?? session.title);
          store.put("sessions", sessionId, session);
          result = session;
        } else if (method === "DELETE" && path.length === 3) {
          if (["router", "role", "worker", "group"].includes(session.workspaceRole ?? "")) throw new HttpError(409, "受管理会话保留任务与频道身份；请使用停止任务或删除专员");
          await messageQueue!.archiveSession(sessionId);
          await agents.abort(sessionId);
          store.transaction(() => {
            store!.delete('sessionModelChoices', sessionId);
            store!.delete('sessions', sessionId);
          });
          result = {};
        } else if (method === "GET" && path.length === 3) result = session;
        else throw new HttpError(path.length === 3 ? 405 : 404, "会话接口不存在或不支持此请求方法");
      } else if (path[1] === "navigation-delete" && path.length === 2 && method === 'POST') result = resourceNavigation.remove(data.kind, data.id);
      else if (path[1] === "navigation-trash" && path.length === 2) {
        if (method === 'GET') result = resourceNavigation.trash();
        else if (method === 'POST') result = resourceNavigation.restore(data.kind, data.id);
        else throw new HttpError(405, '不支持此回收站请求');
      }
      else if (path[1] === "settings" && path[2] === "mcp") {
        if (path.length === 3 && method === "GET") result = extensions!.servers();
        else if (path.length === 3 && method === "POST") result = extensions!.save(undefined, data);
        else if (path.length === 4 && path[3] === "import" && method === "POST") result = extensions!.import(data);
        else if (path.length === 4 && method === "PUT") result = extensions!.save(path[3], data);
        else if (path.length === 4 && method === "DELETE") result = extensions!.remove(path[3]);
        else if (path.length === 5 && path[4] === "test" && method === "POST") {
          const cancel = new AbortController();
          response.on("close", () => { if (!response.writableFinished) cancel.abort(); });
          result = await extensions!.test(path[3], cancel.signal);
        } else throw new HttpError(405, "不支持此 MCP 配置操作");
      } else if (path[1] === "settings" && path[2] === "skills") {
        if (path.length === 3 && method === "GET") result = extensions!.skills();
        else if (path.length === 4 && path[3] === "roots" && ["POST", "DELETE"].includes(method)) result = extensions!.skillRoot(data.path, method === "DELETE");
        else if (path.length === 4 && method === "GET") result = extensions!.skill(path[3]);
        else if (path.length === 4 && method === "PUT") result = extensions!.saveSkill(path[3], data);
        else if (path.length === 4 && method === "DELETE") result = extensions!.removeSkill(path[3]);
        else throw new HttpError(405, "不支持此 Skill 配置操作");
      } else if (path[1] === "gateway") {
        if (path[2] === "invites" && path.length === 4 && method === "GET") {
          const gatewayOrigin = ingressOrigin ?? (await gatewayIngress!.ensure(origin));
          result = gateway!.inspectInvite(path[3], gatewayOrigin);
        } else if (path[2] === "invites" && path.length === 5 && path[4] === "redeem" && method === "POST") {
          if (draining) throw new HttpError(503, "服务正在退出");
          const gatewayOrigin = ingressOrigin ?? (await gatewayIngress!.ensure(origin));
          result = gateway!.redeemInvite(path[3], gatewayOrigin);
        } else if (path[2] === "mcp" && path.length === 3 && method === "POST") {
          const auth = gateway!.authenticate(bearer);
          const connection = gateway!.requireConnection(auth);
          const guard = () => {
            const current = gateway!.requireConnection(gateway!.authenticate(bearer));
            if (current.id !== connection.id || current.updatedAt !== connection.updatedAt) throw new HttpError(409, '连接配置已变化，请重新读取后重试');
            validateGatewayScope(current.projectId, current.routing);
          };
          guard();
          const rpcId = data.id ?? null;
          const rpcMethod = typeof data.method === "string" ? data.method : "";
          const params = (data.params && typeof data.params === "object" && !Array.isArray(data.params) ? data.params : {}) as Record<string, unknown>;
          const mcpTools = [
            {
              name: "send_message",
              description: "向此连接绑定的 Lake 专员/项目发送请求。若涉及需审批资源，专员会在 Lake 主对话发起人工审批，获批后执行。",
              inputSchema: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  thread_id: { type: "string" },
                  client_message_id: { type: "string" },
                  thread_title: { type: "string" },
                  reply_to: { type: "string" },
                },
                required: ["text", "thread_id", "client_message_id"],
                additionalProperties: false,
              },
            },
            {
              name: "get_message_status",
              description: "查询本连接发送消息的处理状态、审批结果与专员报告。",
              inputSchema: {
                type: "object",
                properties: { message_id: { type: "string" } },
                required: ["message_id"],
                additionalProperties: false,
              },
            },
            {
              name: "wait_message",
              description: "等待消息进入审批、回复或结束状态。",
              inputSchema: {
                type: "object",
                properties: { message_id: { type: "string" }, timeout_seconds: { type: "integer" } },
                required: ["message_id"],
                additionalProperties: false,
              },
            },
            {
              name: "test_connection",
              description: "检查当前 Streamable HTTP MCP 连接和已授权资源范围。",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
          ];
          if (rpcMethod === "initialize") {
            result = {
              jsonrpc: "2.0",
              id: rpcId,
              result: {
                protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "lake-remote-mcp", version: __LAKE_VERSION__ },
              },
            };
          } else if (rpcMethod === "notifications/initialized" || rpcMethod === "ping") {
            result = { jsonrpc: "2.0", id: rpcId, result: {} };
          } else if (rpcMethod === "tools/list") {
            result = { jsonrpc: "2.0", id: rpcId, result: { tools: mcpTools } };
          } else if (rpcMethod === "tools/call") {
            const toolName = typeof params.name === "string" ? params.name : "";
            const args = (params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
            try {
              let payload: unknown;
              if (toolName === "test_connection") {
                payload = { connection, ready: true, message: "Lake 远程 MCP 连接已就绪。", lastReceivedAt: superagent.lastGatewayMessageAt(connection.id) };
              } else if (toolName === "send_message") {
                if (draining) throw new HttpError(503, "服务正在退出");
                payload = await superagent.gatewayMessage(connection, {
                  text: String(args.text ?? ""),
                  threadId: String(args.thread_id ?? ""),
                  clientMessageId: String(args.client_message_id ?? ""),
                  ...(args.thread_title !== undefined ? { threadTitle: String(args.thread_title) } : {}),
                  ...(args.reply_to !== undefined ? { replyTo: String(args.reply_to) } : {}),
                }, guard);
              } else if (toolName === "get_message_status") {
                payload = await superagent.gatewayMessageStatus(connection.id, args.message_id, 0, guard);
              } else if (toolName === "wait_message") {
                const waitSeconds = Math.min(60, Math.max(0, Number(args.timeout_seconds ?? 30) || 0));
                payload = await superagent.gatewayMessageStatus(connection.id, args.message_id, waitSeconds, guard);
              } else {
                throw new HttpError(404, `未知 MCP 工具：${toolName}`);
              }
              guard();
              result = {
                jsonrpc: "2.0",
                id: rpcId,
                result: { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] },
              };
            } catch (error) {
              result = {
                jsonrpc: "2.0",
                id: rpcId,
                result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true },
              };
            }
          } else {
            result = { jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: `Unsupported MCP method: ${rpcMethod}` } };
          }
        } else {
        const auth = gateway!.authenticate(bearer);
        if (path[2] === 'connection' || path[2] === 'messages') {
          const connection = gateway!.requireConnection(auth);
          const guard = () => {
            const current = gateway!.requireConnection(gateway!.authenticate(bearer));
            if (current.id !== connection.id || current.updatedAt !== connection.updatedAt) throw new HttpError(409, '连接配置已变化，请重新读取后重试');
            validateGatewayScope(current.projectId, current.routing);
          };
          guard();
          if (path[2] === 'connection' && path.length === 3 && method === 'GET')
            result = {connection, ready: true, message: 'Lake 后端已就绪；此请求已通过当前连接认证。', lastReceivedAt: superagent.lastGatewayMessageAt(connection.id)};
          else if (path[2] === 'messages' && path.length === 3 && method === 'POST') {
            if (draining) throw new HttpError(503, '服务正在退出');
            if (Object.keys(data).some(key => !['text', 'threadId', 'threadTitle', 'clientMessageId', 'replyTo'].includes(key))) throw new HttpError(400, '消息字段无效');
            result = await superagent.gatewayMessage(connection, data as import('../../web-agent/shared/contracts').GatewayMessageInput, guard);
            status = 202;
          } else if (path[2] === 'messages' && path.length === 4 && method === 'GET') {
            const waitSeconds = Number(url.searchParams.get('waitSeconds') ?? 0);
            if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 60) throw new HttpError(400, 'waitSeconds 须为 0–60 的整数');
            result = await superagent.gatewayMessageStatus(connection.id, path[3], waitSeconds, guard);
          } else throw new HttpError(405, '不支持此消息接入请求');
          guard();
        } else if (path[2] === "specialists" && path.length === 3 && method === "GET") {
          gateway!.requireLegacy(auth);
          const { specialists } = superagent.gatewaySpecialists(url.searchParams.get("projectId") || undefined);
          result = { specialists: auth.roles ? specialists.filter(specialist => auth.roles!.includes(specialist.roleId)) : specialists };
        } else if (path[2] === "specialists" && path.length === 5 && path[4] === "instructions" && method === "POST") {
          const guard = () => gateway!.requireRole(gateway!.authenticate(bearer), path[3]);
          guard();
          if (draining) throw new HttpError(503, "服务正在退出");
          result = await superagent.gatewayInstruction(path[3], { text: data.text, clientRequestId: data.clientRequestId }, guard);
          guard();
          status = 202;
        } else if (path[2] === "instructions" && path.length === 4 && method === "GET") {
          const waitSeconds = Number(url.searchParams.get("waitSeconds") ?? 0);
          if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 60) throw new HttpError(400, "waitSeconds 须为 0–60 的整数");
          const event = store.get<{ external?: unknown; preferredRoleId?: string }>("superInputs", path[3]) ??
            store.list<{ external?: unknown; preferredRoleId?: string; messageId?: string }>("superInputs")
              .find(candidate => candidate.external && candidate.messageId === path[3]);
          if (!event?.external) throw new HttpError(404, "外部指令不存在");
          if ((event.external as {connectionId?: string}).connectionId) throw new HttpError(403, '项目连接消息不可通过专员接口读取');
          gateway!.requireRole(auth, event.preferredRoleId ?? "");
          result = await superagent.instructionStatus(path[3], waitSeconds);
          gateway!.requireRole(gateway!.authenticate(bearer), event.preferredRoleId ?? '');
        } else throw new HttpError(405, "不支持此网关请求");
        }
      } else if (path[1] === "settings" && path[2] === "gateway") {
        if (path[3] === 'connections') {
          if (path.length === 4 && method === 'GET') {
            const projects = store.activeProjects().map(({id, name}) => ({id, name}));
            result = {
              connections: gateway!.connections().map(connection => ({...connection, lastReceivedAt: superagent!.lastGatewayMessageAt(connection.id)})),
              command: gatewayCommand(), projects,
              specialists: superagent.gatewaySpecialists().specialists, legacyTokens: gateway!.list().tokens,
              eventSources: eventReceiver!.list(projects.map(project => project.id), origin),
            };
          }
          else if (path.length === 4 && method === 'POST') {
            validateGatewayScope(data.projectId, data.routing);
            result = gateway!.createConnection(data); status = 201;
          } else if (path.length === 5 && method === 'PATCH') {
            const current = gateway!.connection(path[4]);
            if (data.routing !== undefined || data.enabled === true) validateGatewayScope(current.projectId, data.routing ?? current.routing);
            result = gateway!.updateConnection(path[4], data);
          } else if (path.length === 5 && method === 'DELETE') result = gateway!.removeConnection(path[4]);
          else if (path.length === 6 && path[5] === 'messages' && method === 'GET') {
            gateway!.connection(path[4]);
            const limit = Number(url.searchParams.get('limit') ?? 20);
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, 'limit 须为 1–50 的整数');
            result = superagent.gatewayMessages(path[4], {limit, cursor: url.searchParams.get('cursor') ?? undefined});
          } else if (path.length === 6 && path[5] === 'test' && method === 'POST') {
            const connection = gateway!.connection(path[4]); validateGatewayScope(connection.projectId, connection.routing);
            result = {ready: connection.enabled, lastReceivedAt: superagent.lastGatewayMessageAt(connection.id),
              message: connection.enabled ? 'Lake 后端与连接配置已就绪。请从外部客户端调用 test_connection 验证实际接入。' : '连接已停用；启用后可测试外部客户端接入。'};
          } else throw new HttpError(405, '不支持此接入连接操作');
        } else if (path[3] === "tokens" && path.length === 4 && method === "GET") result = {...gateway!.list(), command: gatewayCommand()};
        else if (path[3] === "tokens" && path.length === 4 && method === "POST") { result = gateway!.create(data); status = 201; }
        else if (path[3] === "tokens" && path.length === 5 && method === "DELETE") result = gateway!.remove(path[4]);
        else if (path[3] === "specialists" && path.length === 4 && method === "GET") result = superagent.gatewaySpecialists();
        else throw new HttpError(405, "不支持此网关凭据操作");
      } else if (path[1] === "ai" && path[2] === "presets" && path.length === 3) {
        if (method === "GET") result = store.list("aiPresets");
        else if (method === "POST") {
          if (typeof data.title !== "string" || !data.title.trim() || data.title.length > 200 || typeof data.content !== "string" || !data.content.trim() || Buffer.byteLength(data.content) > 128000 ||
              data.id !== undefined && (typeof data.id !== "string" || !/^[a-zA-Z0-9_.-]{1,200}$/.test(data.id))) throw new HttpError(400, "预设标题、内容或身份无效");
          const key = data.id ?? id();
          result = store.put("aiPresets", key, {id: key, title: data.title.trim(), content: data.content});
        } else if (method === "DELETE") {
          if (typeof data.id !== "string") throw new HttpError(400, "预设身份必填");
          store.require("aiPresets", data.id); store.delete("aiPresets", data.id); result = {deleted: true};
        } else throw new HttpError(405, "不支持此预设请求");
      }
      else throw new HttpError(404, "接口不存在");
      json(response, status, result);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        ssh?.scrub(error instanceof Error ? error.message : String(error)) ?? agents?.redact(error instanceof Error ? error.message : String(error)) ?? "请求失败";
      json(response, status, { error: message });
    }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  gatewayIngress = new GatewayLanIngress(
    (request, response, lanOrigin) => { void handleRequest(request, response, lanOrigin); },
    () => store?.get<number>("settings", "gatewayLanPort"),
    port => { store?.put("settings", "gatewayLanPort", port); },
  );
  const close = async () => {
    if (closed) return;
    closed = true;
    draining = true;
    resourceImport?.close();
    for(const stream of catalogStreams)stream.end();
    await jumpServer?.close();
    await messageQueue?.close();
    await superagent?.close();
    await memory?.close();
    await agents?.close();
    await terminals?.close();
    await ssh?.close();
    services?.close();mysql?.close();
    await eventReceiver?.close();
    await gatewayIngress?.close();
    await execution?.close();
    await extensions?.close();
    gateway?.close();
    for (const response of new Set([...clients.values()].flatMap(set=>[...set]))) response.end();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    store?.close();
    await unlink(join(options.data, "runtime.json")).catch(() => {});
    await unlink(lockPath).catch(() => {});
  };
  try {
    store = await LakeStore.open(options.home, options.data);
    if (options.development||options.production) await importLegacyModelSettings(store);
    agents = await LakeAgents.open(store, broadcast,options.codexHome);
    store.magpie = await LakeMagpie.connect(store, key => agents!.registerSecret(key));
    security = new LakeSecurity(store);
    gateway = new LakeGateway(options.home, security);
    extensions = new LakeExtensions(store, security, (value) => agents!.redact(value));
    jumpServer = new LakeJumpServer(store,security,value=>agents!.registerSecret(value),catalogChanged);
    ssh=new LakeSSH(store,security,(session)=>{broadcast(store!.event(session,"session"));superagent?.changed(session);},value=>extensions!.scrub(value),value=>agents!.registerSecret(value),jumpServer);
    mysql=new LakeMySQL(store,security,value=>agents!.registerSecret(value),value=>agents!.redact(value));
    services=new LakeServiceResources(store,security,value=>agents!.registerSecret(value),value=>agents!.redact(ssh!.scrub(extensions!.scrub(value))));
    terminals = new LakeTerminals(store, security, (value, live) => live ? agents!.redactLive(ssh!.scrub(extensions!.scrubLive(value),true)) : ssh!.scrub(value), broadcast,ssh);
    agents.guard = () => security!.check();
    if (options.importLegacy) {
      if (!options.development&&!options.production) throw new HttpError(403, "旧数据迁移需要明确指定 Dev 或正式版运行身份");
      await agents.prepareRedaction();
      await applyLegacyMigration(store, (value) => agents!.redact(value));
      await importLegacySSH(store,ssh);
      await importLegacyMySQL(store,mysql);
      await importLegacyServices(store, services);
      await importLegacyWorkflows(store, value => agents!.redact(value));
      // A closed recovery gate preserves read-only startup and all old records.
      if (!security.readOnly()) {
        try { await importLegacyMCP(store, security); store.delete("settings", "legacyMcpMigrationError"); }
        catch { store.put("settings", "legacyMcpMigrationError", {reason: "原项目 MCP 设置需核实；未扩大项目服务权限", at: now()}); }
      }
    }
    // Preparation must not start Workers, Watchdog, queued inputs or Memory
    // extraction. The actual application launch owns those runtime services.
    if(options.importOnly)return {origin,token,store,agents,superagent,memory,mysql,services,execution,close};
    eventReceiver = new LakeEventReceiver(store, security, value => ssh!.scrub(extensions!.scrub(value)), () => draining);
    await eventReceiver.restoreLocalReceivers();
    execution=new LakeExecution(store,security,ssh,value=>agents!.redact(ssh!.scrub(value)));
    const resourceNavigation=new LakeResourceNavigation(store,(projectId,actorSessionId)=>store!.list<any>('sessions').some(session=>session.projectId===projectId&&session.id!==actorSessionId&&agents!.isRunning(session.id)));
    resourceManagement=new LakeResourceManagement(store,security,ssh,services,resourceNavigation);
    resourceImport=new LakeResourceImport(store,resourceManagement,value=>agents!.registerSecret(value),options.resourceImport);
    const configuration=new PilotConfiguration(store,security,extensions,resourceManagement,value=>agents!.redact(ssh!.scrub(extensions!.scrub(value))));
    const allowAutomationOverrides = options.allowAutomationOverrides === true;
    superagent = new LakeSuperagent(store, agents, security, extensions,ssh,mysql,execution,Date.now,configuration,services,allowAutomationOverrides,catalogChanged);
    memory = new LakeMemory(store, () => security!.check(), value => agents!.redact(ssh!.scrub(extensions!.scrub(value))), allowAutomationOverrides);
    try { await memory.initialize(); } catch { memory.disable("记忆文件需要核实，当前暂停记忆功能；原记录保留，普通新任务仍可运行"); }
    agents.memory = memory;
    messageQueue = new LakeMessageQueue(store, () => security!.check(), session => superagent!.messageQueueBusy(session),
      async (session, item) => { const input = messageInput(store!, session, item.text, item); return superagent!.send(session, item.text, item.taskId, item.ignoreProjectMemory === true, input); },
      session => broadcast(store!.event(session, 'session')), value => agents!.redact(value));
    try{memory.searchIndex=await openClaudeMemIndex(store,()=>security!.check());}catch{memory.searchIndexError='本地检索索引未就绪，仍可使用有效的 Lake 记忆。';}
    memory.runNative = work => agents!.runMemory(work);
    memory.isForegroundBusy = () => agents!.foregroundBusy();
    memory.validateOperation = operation => superagent!.ledger.revalidate?.(operation);
    memory.wake();
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(options.port, "localhost", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("无法确定服务端口");
    origin = `http://localhost:${address.port}`;
    try {
      if (gateway?.connections().some(connection => connection.enabled && connection.resourceGrants !== undefined)) {
        await gatewayIngress?.ensure(origin);
      }
    } catch { /* LAN ingress remains lazily retryable on demand. */ }
    const runtimePath = join(options.data, "runtime.json");
    const pending = join(options.data, `.runtime-${id()}`);
    await writeFile(pending, encode({ origin, token, pid: process.pid }), { mode: 0o600 });
    await rename(pending, runtimePath);
  } catch (error) {
    await close();
    throw error;
  }
  return { origin, token, store, agents, superagent, memory, mysql, services, execution, close };
}

async function main() {
  const args = process.argv.slice(2);
  if(args[0]==='--internal-acp-mcp'){
    if(!args[1])throw new Error('ACP 工具桥缺少原任务端点');
    const {runToolBridge}=await import('./acp/bridge');await runToolBridge(args[1]);return;
  }
  if(args[0]==='--mcp-channel'){
    const option=(name:string)=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
    const home=option('--home'),connectionId=option('--connection');
    if(!home||!connectionId)throw new Error('请使用 --home 和 --connection 显式指定 Lake 数据目录与接入连接');
    const {runChannelMcp}=await import('./mcp-stdio');
    await runChannelMcp({home,data:option('--data'),connectionId});return;
  }
  if(args[0]==='--mcp-specialist'){
    const option=(name:string)=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
    const home=option('--home')??process.env.LAKE_HOME;
    if(!home)throw new Error('请使用 --home 显式指定 Lake 数据目录');
    const {runSpecialistMcp}=await import('./mcp-stdio');
    await runSpecialistMcp({home,data:option('--data'),role:option('--role'),tokenId:option('--token-id')});return;
  }
  if (args.includes("--version")) {
    console.log(`Lake ${typeof __LAKE_VERSION__==='undefined'?'development':__LAKE_VERSION__} TypeScript`);
    return;
  }
  if (args.includes("--help") || !args.length) {
    console.log(
      "Lake TypeScript backend\n用法：lake web --home <目录> [--port 0] [--data <目录>] [--dev | --production]\n消息渠道接入：lake --mcp-channel --home <目录> --connection <id> [--data <目录>]\n兼容专员入口：lake --mcp-specialist --home <目录> [--role <roleId>] [--token-id <id>]",
    );
    return;
  }
  if (args[0] !== "web") throw new Error("此入口仅支持 web；旧 Go CLI 已退出当前后端运行路径");
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const home = option("--home") ?? process.env.LAKE_HOME;
  if (!home) throw new Error("请使用 --home 显式指定 Lake 数据目录");
  const data = option("--data") ?? process.env.LAKE_WEB_DATA_DIR ?? join(home, "web-agent");
  const port = Number(option("--port") ?? 4182);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("无效的端口");
  const root = isSea() ? join(dirname(process.execPath), "lake-runtime") : __dirname;
  const app = await startLakeServer({ home, data, port, staticRoot: join(root, "web"), development: args.includes("--dev"), production:args.includes('--production'), importLegacy: args.includes("--migrate-legacy"),importOnly:args.includes('--import-only'),
    grafanaReceiverBase: process.env.LAKE_GRAFANA_RECEIVER_BASE_URL });
  if (args.includes("--import-only")) {
    console.log("Lake legacy catalog migration completed; original Go databases and execution ledgers retained");
    await app.close(); return;
  }
  const shutdown = () => void app.close();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(`Lake TypeScript backend listening at ${app.origin}`);
}
if (process.env.LAKE_TS_IMPORT_ONLY !== "1")
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Lake backend startup failed");
    process.exitCode = 1;
  });
