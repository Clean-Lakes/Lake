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

export type ServerOptions = { home: string; data: string; port: number; staticRoot: string };
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
      if (!store || !agents) throw new HttpError(503, "服务正在启动");
      if (path[1] === "bootstrap")
        response.setHeader(
          "Set-Cookie",
          `lake_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
        );
      const data = method === "GET" || method === "HEAD" ? {} : await body(request);
      const navigation = new LakeNavigation(store, broadcast);
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
          terminalMode: "command",
          aiRuntime: "zcode",
          backendRuntime: "typescript",
          upstreamVersion: "3.17.2",
          recoveryReadOnly: false,
        };
      };
      let result: unknown;
      let status = 200;
      if (path[1] === "bootstrap") result = bootstrap();
      else if (path[1] === "catalog") result = store.catalog();
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
        if (method === "GET") result = catalog();
        else if (method === "DELETE") {
          store.delete("providers", path[3]);
          await store.secret(path[3], null);
          result = catalog();
        } else if (["test", "discover", "detect-capabilities"].includes(path[4])) {
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
        } else {
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
        }
      } else if (path[1] === "settings" && path[2] === "model") {
        if (path[3] === "select") {
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
              },
            ],
          };
          store.put("providers", providerId, provider);
          store.put("settings", "modelSelection", { providerId, modelId: name });
          result = modelSettings();
        } else if (method === "DELETE") {
          store.delete("settings", "modelSelection");
          result = modelSettings();
        } else result = modelSettings();
      } else if (path[1] === "projects" && path.length === 4 && path[3] === "tags" && method === "POST") {
        result = navigation.createTag(path[2], data);
        status = 201;
      } else if (path[1] === "projects" && path.length === 4 && path[3] === "session-navigation" && method === "POST")
        result = navigation.move(path[2], data);
      else if (path[1] === "tags" && path.length === 3) {
        if (method === "PUT") result = navigation.updateTag(path[2], data);
        else if (method === "DELETE") result = navigation.deleteTag(path[2]);
        else throw new HttpError(405, "不支持此请求方法");
      } else if (path[1] === "projects" && path.length === 2 && method === "POST")
        result = store.createProject(String(data.name ?? ""));
      else if (path[1] === "projects" && path[3] === "sessions" && method === "POST")
        result = store.createSession(path[2]);
      else if (path[1] === "projects" && path[3] === "resources") {
        store.project(path[2]);
        if (method === "GET")
          result = store.catalog().resources.filter((resource) => resource.projectId === path[2]);
        else {
          if (data.kind !== "local") throw new HttpError(501, "远程资源连接尚未迁移完成");
          const resource: Resource = {
            id: id(),
            projectId: path[2],
            name: String(data.name ?? "本机"),
            kind: "local",
            description: "",
            status: "available",
            settings: data.settings ?? {},
          };
          store.put("resources", resource.id, resource);
          result = resource;
        }
      } else if (path[1] === "projects" && path[3] === "superagent") {
        store.project(path[2]);
        if (method !== "GET") throw new HttpError(501, "Pilot 与长期专员调度尚未迁移完成");
        result = {
          active: false,
          project: { projectId: path[2], routerSessionId: "", version: 0 },
          workers: [],
          channels: [],
        };
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
        if (path[3] === "terminals") result = { terminals: [] };
        else if (method === "PATCH") {
          resource.name = String(data.name ?? resource.name);
          resource.settings = data.settings ?? resource.settings;
          store.put("resources", resource.id, resource);
          result = resource;
        } else result = resource;
      } else if (path[1] === "sessions") {
        const sessionId = path[2];
        const session = store.session(sessionId);
        if (path.length === 4 && path[3] === "presentation") {
          if (method !== "PUT") throw new HttpError(405, "不支持此请求方法");
          result = navigation.presentation(sessionId, data);
        } else if (path[3] === "snapshot") result = store.snapshot(sessionId);
        else if (path[3] === "events") {
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
        } else if (path[3] === "messages" && method === "POST") {
          if (draining) throw new HttpError(503, "服务正在退出");
          if (
            (data.images?.length ?? 0) ||
            (data.files?.length ?? 0) ||
            (data.references?.length ?? 0)
          )
            throw new HttpError(501, "附件与资源引用尚未迁移完成");
          result = await agents.send(sessionId, String(data.text ?? ""));
          status = 202;
        } else if (path[3] === "message-queue") {
          if (method !== "GET") throw new HttpError(501, "消息队列尚未接入");
          result = { paused: false, revision: 0, lastError: "", items: [] };
        } else if (path[3] === "ai") {
          switch (path[4]) {
            case undefined:
            case "snapshot":
              result = store.view(sessionId);
              break;
            case "options":
              result = session.options;
              break;
            case "configure":
              if (agents.isRunning(sessionId))
                throw new HttpError(409, "请先停止当前任务再修改配置");
              session.options = { ...session.options, ...data, agentRuntime: "zcode" };
              store.put("sessions", sessionId, session);
              result = session.options;
              break;
            case "abort":
              await agents.abort(sessionId);
              result = {};
              break;
            case "decision":
              agents.decision(sessionId, String(data.id), data.accept === true);
              result = {};
              break;
            case "references":
              result = [];
              break;
            case "reasoning":
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
        } else if (method === "PATCH") {
          session.title = String(data.title ?? session.title);
          store.put("sessions", sessionId, session);
          result = session;
        } else if (method === "DELETE") {
          await agents.abort(sessionId);
          store.delete("sessions", sessionId);
          result = {};
        } else result = session;
      } else if (path[1] === "navigation-trash") result = { items: [] };
      else if (path[1] === "settings" && path[2] === "mcp") {
        if (method !== "GET") throw new HttpError(501, "MCP 配置尚未迁移完成");
        result = { servers: [] };
      } else if (path[1] === "settings" && path[2] === "skills") {
        if (method !== "GET") throw new HttpError(501, "Skill 配置尚未迁移完成");
        result = { skills: [], roots: [] };
      } else if (path[1] === "ai" && path[2] === "presets") result = [];
      else throw new HttpError(404, "接口不存在");
      json(response, status, result);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        agents?.redact(error instanceof Error ? error.message : String(error)) ?? "请求失败";
      json(response, status, { error: message });
    }
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    draining = true;
    await agents?.close();
    for (const set of clients.values()) for (const response of set) response.end();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    store?.close();
    await unlink(join(options.data, "runtime.json")).catch(() => {});
    await unlink(lockPath).catch(() => {});
  };
  try {
    store = await LakeStore.open(options.home, options.data);
    agents = await LakeAgents.open(store, broadcast);
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
  return { origin, token, store, agents, close };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--version")) {
    console.log("Lake · TypeScript / ZCode 3.17.2");
    return;
  }
  if (args.includes("--help") || !args.length) {
    console.log(
      "Lake TypeScript backend\n用法：lake web --home <隔离目录> [--port 0] [--data <目录>]",
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
  const root = isSea() ? join(dirname(process.execPath), "lake-zcode") : __dirname;
  const app = await startLakeServer({ home, data, port, staticRoot: join(root, "web") });
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
