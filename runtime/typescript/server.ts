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
  ModelProvider,
  ProviderModel,
  Resource,
  Project,
  ResourceTreeNode,
} from "../../web-agent/shared/contracts";
import { LakeStore, HttpError, id, now, privateDirectory } from "./store";
import { LakeAgents } from "./agent";
import { LakeNavigation } from "./navigation";
import { LakeResourceNavigation } from "./resource-navigation";
import {messageInput} from './message-input';
import {LakeMySQL} from "./mysql";
import {LakeExecution} from "./execution";
import {agentCapabilityCatalog,nativeSearchSupported} from "./capabilities";
import { importDevModelSettings } from "./dev-settings";
import { LakeSuperagent } from "./superagent";
import { applyLegacyMigration, importLegacySSH, importLegacyMySQL, importLegacyMCP, loadLegacyView } from "./migration";
import { digest } from "./tasks";
import { LakeSecurity } from "./security";
import { LakeMemory } from "./memory";
import {openClaudeMemIndex} from './claude-mem';
import {LakeServiceResources,isServiceKind} from './service-resources';
import { LakeExtensions } from "./extensions";
import {LakeSSH} from "./ssh";
import { LakeTerminals } from "./terminal";
import { commandPolicy } from "../../web-agent/shared/command-policy";
export { previewLegacyMigration, rollbackMigration, importLegacyMySQL, importLegacyMCP } from "./migration";
export { LakeMemory } from "./memory";
export {sessionArchiveName, legacySessionArchiveName} from "./session-archive";

export type ServerOptions = { home: string; data: string; port: number; staticRoot: string; development?: boolean; importLegacy?: boolean };
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
  for (const name of [".lake", ".lake-dev"]) {
    const protectedHome = await canonicalNewPath(resolve(homedir(), name));
    // The user explicitly authorized replacing Lake Dev with the TS build.
    // Only its explicit --dev launch can use daily Dev data; release is always denied.
    if (name === ".lake-dev" && options.development && options.home === protectedHome &&
        options.data.startsWith(protectedHome + sep)) continue;
    if (
      [options.home, options.data].some(
        (path) => path === protectedHome || path.startsWith(protectedHome + sep),
      )
    )
      throw new Error("TS 候选必须使用独立 Home；功能等价验收前不能接管 Lake 或 Lake Dev 数据");
  }
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
  let security: LakeSecurity | undefined;
  let memory: LakeMemory | undefined;
  let extensions: LakeExtensions | undefined;
  let terminals: LakeTerminals | undefined;
  let ssh:LakeSSH|undefined;
  let mysql:LakeMySQL|undefined;
  let services:LakeServiceResources|undefined;
  let execution:LakeExecution|undefined;
  let draining = false;
  let closed = false;
  const clients = new Map<string, Set<ServerResponse>>();
  const token = randomBytes(32).toString("hex");
  let origin = "";
  const broadcast = (event: any) => {
    for (const response of clients.get(event.sessionId) ?? [])
      response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${encode(event)}\n\n`);
  };
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(encode(value));
  };
  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    try {
      const url = new URL(request.url ?? "/", origin || "http://localhost");
      const path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const method = request.method ?? "GET";
      if (request.headers.origin && request.headers.origin !== origin)
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
      const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const cookie =
        request.headers.cookie
          ?.split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("lake_session="))
          ?.slice("lake_session=".length) ?? "";
      if (!equal(token, bearer) && !equal(token, cookie))
        throw new HttpError(401, "需要 Lake 访问凭据");
      if (!store || !agents || !superagent) throw new HttpError(503, "服务正在启动");
      if (path[1] === "bootstrap")
        response.setHeader(
          "Set-Cookie",
          `lake_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
        );
      const data = method === "GET" || method === "HEAD" ? {} : await body(request);
      const cleanup=path[1]==="sessions"&&(path[3]==="host-key"&&data.accept===false||path[3]==="terminals"&&path[5]==="disconnect")||path[1]==="projects"&&path[3]==="superagent"&&path[4]==="stop"&&path.length===5&&method==="POST";
      if (!["GET", "HEAD"].includes(method) && !cleanup && !(path[1] === "superagent" && path[2] === "lifecycle")) security?.check();
      const navigation = new LakeNavigation(store, broadcast);
      const resourceNavigation = new LakeResourceNavigation(store, projectId => store!.list<any>('sessions').some(session => session.projectId === projectId && agents!.isRunning(session.id)));
      const selection = () =>
        store!.get<{ providerId: string; modelId: string }>("settings", "modelSelection");
      const catalog = () => ({
        providers: store!.list<ModelProvider>("providers"),
        activeProviderId: selection()?.providerId ?? "",
        activeModelId: selection()?.modelId ?? "",
      });
      const selected = () => {
        const choice = selection();
        const provider = choice && store!.get<ModelProvider>("providers", choice.providerId);
        return { provider, model: provider?.models.find((model) => model.id === choice?.modelId) };
      };
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
        const entries = catalog()
          .providers.filter((provider) => provider.enabled)
          .flatMap((provider) =>
            provider.models.filter((model) => model.enabled).map((model) => entry(provider, model)),
          );
        return {
          models: entries.map((model) => model.name),
          entries,
          activeModelId: model?.id ?? "",
          activeProviderId: provider?.id ?? "",
        };
      };
      const bootstrap = () => {
        const { provider, model } = selected();
        return {
          authenticated: true,
          modelConfigured: !!model,
          modelName: model?.name ?? null,
          modelId: model?.id ?? null,
          modelSelection: model && provider ? entry(provider, model) : null,
          supportsImageInput: model?.supportsImageInput ?? false,
          terminalMode: terminals?.supported ? "pty" : "command",
          aiRuntime: "typescript",
          memoryEngine: "layered",
          backendRuntime: "typescript",
          upstreamVersion: "3.17.2",
          recoveryReadOnly: security?.readOnly() ?? true,
        };
      };
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
          const base = String(data.baseURL ?? existing?.baseURL ?? "").replace(
            /\/(chat\/completions|responses|messages)\/?$/,
            "",
          );
          const key = data.apiKey ?? (await store.secret(path[3]));
          const probe = await fetch(base.replace(/\/$/, "") + "/models", {
            headers: key ? { Authorization: `Bearer ${key}` } : {},
            signal: AbortSignal.timeout(15000),
          });
          if (!probe.ok) throw new HttpError(502, `模型服务返回 HTTP ${probe.status}`);
          const response = (await probe.json()) as { data?: { id: string }[] };
          result =
            path[4] === "test"
              ? { ok: true, message: "模型服务连接正常" }
              : { models: (response.data ?? []).map((item) => ({ id: item.id, name: item.id })) };
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
          const provider = store.require<ModelProvider>("providers", String(data.providerId));
          if (
            !provider.enabled ||
            !provider.models.some((model) => model.id === data.modelId && model.enabled)
          )
            throw new HttpError(400, "模型不可用");
          store.put("settings", "modelSelection", {
            providerId: data.providerId,
            modelId: data.modelId,
          });
          result = catalog();
        } else if (path[3] === "state")
          result = {
            ...bootstrap(),
            available: available(),
            providers: catalog(),
            settings: modelSettings(),
          };
        else if (path[3] === "available") result = available();
        else if (path[3] === "capacity")
          result = { limit: selected().model?.contextWindow ?? 128000, source: "provider" };
        else if (method === "PUT") {
          const providerId = "custom";
          const name = String(data.name ?? "");
          if (!name.trim()) throw new HttpError(400, "模型名称不能为空");
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
          store.put("settings", "modelSelection", { providerId, modelId: name });
          result = modelSettings();
        } else if (method === "DELETE") {
          store.delete("settings", "modelSelection");
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
      } else if (path[1] === "projects" && path.length === 4 && path[3] === "tags" && method === "POST") {
        result = navigation.createTag(path[2], data);
        status = 201;
      } else if (path[1] === "projects" && path.length === 4 && path[3] === "session-navigation" && method === "POST")
        result = navigation.move(path[2], data);
      else if (path[1] === "tags" && path.length === 3) {
        if (method === "PUT") result = navigation.updateTag(path[2], data);
        else if (method === "DELETE") result = navigation.deleteTag(path[2]);
        else throw new HttpError(405, "不支持此请求方法");
      } else if(path[1]==="agent-capabilities"&&path.length===2&&method==="GET")result={upstreamVersion:"3.17.2",tools:agentCapabilityCatalog({nativeWebSearch:nativeSearchSupported(selected().provider?.protocol,selected().model?.supportsNativeWebSearch)}),resourceExecution:{local:process.platform==="darwin",ssh:!!execution}};
      else if (path[1] === "projects" && path.length === 2 && method === "POST")
        result = store.createProject(String(data.name ?? ""));
      else if (path[1] === "projects" && path[3] === "sessions" && method === "POST")
        result = store.createSession(path[2]);
      else if (path[1] === "projects" && path[3] === "resource-tree" && path.length === 4) {
        if (method !== 'POST') throw new HttpError(405, '不支持此资源目录请求');
        result = resourceNavigation.edit(path[2], data);
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
        else if(method==='POST'&&isServiceKind(data.kind,data.settings))result=services!.create(path[2],data);
        else {
          if (!["local","ssh"].includes(data.kind)&&!(data.kind==="database"&&data.settings?.driver==="mysql")) throw new HttpError(501, "此资源类型的连接仍在迁移中");
          if(method!=="POST")throw new HttpError(405,"不支持此资源请求");
          const parentId = resourceNavigation.parent(path[2], data.parentId);
          const resource: Resource = {
            id: id(),
            projectId: path[2],
            name: String(data.name ?? "本机"),
            kind: data.kind,
            ...(data.kind==="ssh"?{ssh:ssh!.prepare(data.ssh)}:{}),
            description: "",
            status: "available",
            settings: data.kind==="database"&&data.settings?.driver==="mysql"?mysql!.prepare(data.settings):data.settings ?? {},
          };
          store.transaction(() => { store!.put("resources", resource.id, resource); resourceNavigation.attach(resource, parentId); });
          result = resource;
        }
      } else if (path[1] === "projects" && path[3] === "superagent") {
        store.project(path[2]);
        if(path.length===5&&path[4]==="stop"&&method==="POST")result=await superagent.stopWorkspace(path[2],String(data.routerSessionId??""));
        else if (path.length === 6 && path[4] === "specialists" && method === "DELETE")
          result = await superagent.deleteRole(path[2], path[5], data.revision);
        else if (path.length !== 4) throw new HttpError(404, "Super-agent 接口不存在");
        else if (method === "GET") result = superagent.workspace(path[2]);
        else if (method === "POST") result = superagent.ensure(path[2]);
        else throw new HttpError(405, "不支持此请求方法");
      } else if (path[1] === "projects" && ["pilot", "sre"].includes(path[3])) {
        store.project(path[2]);
        result = { enabled: false, autoAdvance: false, revision: 0 };
        if (method !== "GET") throw new HttpError(501, "Pilot 与长期专员调度尚未迁移完成");
      } else if (path[1] === "projects" && ["workflows", "schedules"].includes(path[3])) {
        store.project(path[2]);
        if (method !== "GET") throw new HttpError(501, "工作流与日程尚未迁移完成");
        result = { items: [], templates: [], runs: [] };
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
      } else if (path[1] === "resources") {
        const resource = store.require<Resource>("resources", path[2]);
        if (path[3] === "terminal-context" && path.length === 4 && method === "POST") result = terminals!.context(resource.id);
        else if (path[3] === "terminals" && method === "GET" && path.length === 4) result = { terminals: terminals!.resourceTerminals(resource.id) };
        else if (path[3] === "terminals" && method === "DELETE" && (path.length === 4 || path.length === 5)) {
          const entries = terminals!.resourceTerminals(resource.id).filter((terminal) => path.length === 4 || terminal.id === path[4]);
          for (const terminal of entries) await terminals!.disconnect(terminal.sessionId, terminal.id);
          result = { closed: entries.length };
        }
        else if (method === 'PATCH'&&path.length===3&&isServiceKind(resource.kind,resource.settings))result=services!.update(resource,data);
        else if (method === "PATCH"&&path.length===3) {
          resource.name = String(data.name ?? resource.name);
          if (data.settings && digest(data.settings) !== digest(resource.settings)) store.put("resourceRevisions", resource.id, (store.get<number>("resourceRevisions", resource.id) ?? 1) + 1);
          resource.settings = resource.kind==="database"&&data.settings?mysql!.prepare(data.settings,resource.settings):data.settings ?? resource.settings;
          if(resource.kind==="database"&&resource.settings?.driver==="mysql")resource.status="available";
          if(data.ssh!==undefined){resource.ssh=ssh!.prepare(data.ssh,resource.ssh);resource.status="available";store.put("resourceRevisions",resource.id,(store.get<number>("resourceRevisions",resource.id)??1)+1);}
          store.put("resources", resource.id, resource);
          result = resource;
        } else if (method === "GET" && path.length === 3) result = {...resource,configurationRevision:store.get<number>('resourceRevisions',resource.id)??1};
        else throw new HttpError(path.length === 3 ? 405 : 404, "资源接口不存在或不支持此请求方法");
      } else if (path[1] === "sessions") {
        const sessionId = path[2];
        const session = store.session(sessionId);
        if (session.workspaceRole === "legacy" && !["GET", "HEAD"].includes(method) && !(path[3] === "presentation" || path.length === 3 && method === "PATCH"))
          throw new HttpError(409, "旧 Go 会话为只读档案；请在 Pilot 中提出新的明确要求，历史任务与操作不会重放");
        if (method === "GET" && (path[3] === "snapshot" || path[3] === "ai")) {
          await agents.prepareRedaction();
          await loadLegacyView(store, sessionId, (value) => agents!.redact(value));
        }
        if (path[3] === "messages-read" && path.length === 4 && method === "PUT") result = acknowledgeConversation(store, sessionId, data.cursor);
        else if (path[3] === "executions" && path.length === 6 && path[5] === "interrupt" && method === "POST") { result = execution!.interrupt(sessionId, path[4], data.generation); status = 202; }
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
          else if (method === "POST" && data.action === "stop") result = await superagent.stopChannel(sessionId);
          else throw new HttpError(405, "不支持此请求方法");
        } else if (path.length === 4 && path[3] === "presentation") {
          if (method !== "PUT") throw new HttpError(405, "不支持此请求方法");
          result = navigation.presentation(sessionId, data);
        } else if (path[3] === "snapshot" && path.length === 4 && method === "GET") { const snapshot = store.snapshot(sessionId); snapshot.ai = store.viewPage(sessionId); result = superagent.decorate(snapshot,url.searchParams.get("taskId")??undefined); }
        else if (path[3] === "events" && path.length === 4 && method === "GET") {
          const after = Number(url.searchParams.get("after") ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, "无效的事件游标");
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          });
          response.write(": connected\n\n");
          for (const event of store.events(sessionId, after))
            response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${encode(event)}\n\n`);
          let set = clients.get(sessionId);
          if (!set) {
            set = new Set();
            clients.set(sessionId, set);
          }
          set.add(response);
          const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000);
          response.on("close", () => {
            clearInterval(heartbeat);
            set!.delete(response);
          });
          return;
        } else if (path[3] === "messages" && path.length === 4 && method === "POST") {
          if (draining) throw new HttpError(503, "服务正在退出");
          if (
            (data.images?.length ?? 0) ||
            (data.files?.length ?? 0)
          )
            throw new HttpError(501, "附件与资源引用尚未迁移完成");
          if (data.terminalReuse) throw new HttpError(501, '终端交接尚未接入，未发送此消息');
          await agents.prepareRedaction();
          const input = messageInput(store, sessionId, agents.redact(String(data.text ?? '')), data);
          result = await superagent.send(sessionId, String(data.text ?? ""), data.taskId, data.ignoreProjectMemory === true, input);
          status = 202;
        } else if (path[3] === "message-queue") {
          if (method !== "GET") throw new HttpError(501, "消息队列尚未接入");
          result = { paused: false, revision: 0, lastError: "", items: [] };
        } else if (path[3] === "ai") {
          if (path.length > 5) throw new HttpError(404, "会话接口不存在");
          const reads = [undefined, "snapshot", "options", "references"];
          if (method !== (reads.includes(path[4]) || path[4] === "reasoning" && method === "GET" ? "GET" : "POST"))
            throw new HttpError(405, "不支持此会话请求方法");
          switch (path[4]) {
            case undefined:
            case "snapshot":
              result = agents.executionView(sessionId, store.viewPage(sessionId, url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined));
              break;
            case "options":
              result = { ...session.options, agentRuntime: "typescript" };
              break;
            case "configure":
              if (agents.isRunning(sessionId))
                throw new HttpError(409, "请先停止当前任务再修改配置");
              session.options = { ...session.options, ...data, agentRuntime: "typescript" };
              store.put("sessions", sessionId, session);
              result = { ...session.options, agentRuntime: "typescript" };
              break;
            case "abort":
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
              result = [];
              break;
            case "reasoning":
              if (method !== "GET") throw new HttpError(501, "当前模型推理等级设置尚未接入");
              result = {
                effort: "",
                levels: [],
                supported: false,
                modelId: selected().model?.id ?? "",
              };
              break;
            default:
              throw new HttpError(501, "此会话操作尚未迁移完成");
          }
        } else if (method === "PATCH" && path.length === 3) {
          session.title = String(data.title ?? session.title);
          store.put("sessions", sessionId, session);
          result = session;
        } else if (method === "DELETE" && path.length === 3) {
          if (["router", "role", "worker"].includes(session.workspaceRole ?? "")) throw new HttpError(409, "受管理会话保留任务与频道身份；请使用停止任务或删除专员");
          await agents.abort(sessionId);
          store.delete("sessions", sessionId);
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
        else throw new HttpError(405, "不支持此 Skill 配置操作");
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
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    draining = true;
    await superagent?.close();
    await memory?.close();
    await agents?.close();
    await terminals?.close();
    await ssh?.close();
    services?.close();mysql?.close();
    await execution?.close();
    await extensions?.close();
    for (const set of clients.values()) for (const response of set) response.end();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    store?.close();
    await unlink(join(options.data, "runtime.json")).catch(() => {});
    await unlink(lockPath).catch(() => {});
  };
  try {
    store = await LakeStore.open(options.home, options.data);
    if (options.development) await importDevModelSettings(store);
    agents = await LakeAgents.open(store, broadcast);
    security = new LakeSecurity(store);
    extensions = new LakeExtensions(store, security, (value) => agents!.redact(value));
    ssh=new LakeSSH(store,security,(session)=>{broadcast(store!.event(session,"session"));superagent?.changed(session);},value=>extensions!.scrub(value),value=>agents!.registerSecret(value));
    mysql=new LakeMySQL(store,security,value=>agents!.registerSecret(value),value=>agents!.redact(value));
    services=new LakeServiceResources(store,security,value=>agents!.registerSecret(value));
    terminals = new LakeTerminals(store, security, (value, live) => live ? agents!.redactLive(ssh!.scrub(extensions!.scrubLive(value),true)) : ssh!.scrub(value), broadcast,ssh);
    agents.guard = () => security!.check();
    if (options.importLegacy) {
      if (!options.development) throw new HttpError(403, "旧数据迁移仅允许明确指定的 Dev 环境");
      await agents.prepareRedaction();
      await applyLegacyMigration(store, (value) => agents!.redact(value));
      await importLegacySSH(store,ssh);
      await importLegacyMySQL(store,mysql);
      // A closed recovery gate preserves read-only startup and all old records.
      if (!security.readOnly()) {
        try { await importLegacyMCP(store, security); store.delete("settings", "legacyMcpMigrationError"); }
        catch { store.put("settings", "legacyMcpMigrationError", {reason: "原项目 MCP 设置需核实；未扩大项目服务权限", at: now()}); }
      }
    }
    execution=new LakeExecution(store,security,ssh,value=>agents!.redact(ssh!.scrub(value)));
    superagent = new LakeSuperagent(store, agents, security, extensions,ssh,mysql,execution);
    await superagent.discoveryRecovery.verify();
    memory = new LakeMemory(store, () => security!.check(), value => agents!.redact(ssh!.scrub(extensions!.scrub(value))));
    try { await memory.initialize(); } catch { memory.disable("记忆文件需要核实，当前暂停记忆功能；原记录保留，普通新任务仍可运行"); }
    agents.memory = memory;
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
  if (args.includes("--version")) {
    console.log("Lake Dev · TypeScript");
    return;
  }
  if (args.includes("--help") || !args.length) {
    console.log(
      "Lake TypeScript backend\n用法：lake web --home <目录> [--port 0] [--data <目录>] [--dev]",
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
  const app = await startLakeServer({ home, data, port, staticRoot: join(root, "web"), development: args.includes("--dev"), importLegacy: args.includes("--migrate-legacy") });
  if (args.includes("--import-only")) {
    console.log("Dev legacy catalog migration completed; original Go databases and execution ledgers retained");
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
