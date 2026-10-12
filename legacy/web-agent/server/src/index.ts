import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AIImage, Action, SessionEvent } from "../../shared/contracts.js";
import { commandPolicy, dangerConfirmation } from "../../shared/command-policy.js";
import { inputReferences } from "./input-references.js";
import { GoAI } from "./go-ai.js";
import { Coordinator } from "./coordinator.js";
import { activeModel, clearModel, endpointText, listModels, modelNameText, modelProtocol, modelSettings, resolveKey, saveModel, testModelConnection } from "./model-config.js";
import { ApiFailure, Store } from "./store.js";
import { TerminalService, validCommand } from "./terminal.js";

const MAX_BODY_BYTES = 16384;
const COOKIE = "lake_web_token";
const generated = !process.env.LAKE_WEB_TOKEN;
const token = process.env.LAKE_WEB_TOKEN || randomBytes(32).toString("hex");
const port = Number(process.env.LAKE_WEB_PORT || 4177);
const host = "127.0.0.1";
const expectedHosts = new Set([
  `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`,
  ...(process.env.LAKE_WEB_DEV_ORIGIN ? [new URL(process.env.LAKE_WEB_DEV_ORIGIN).host] : []),
]);
const allowedOrigins = new Set([
  `http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`,
  ...(process.env.LAKE_WEB_DEV_ORIGIN ? [process.env.LAKE_WEB_DEV_ORIGIN] : []),
]);
const builtWebDist = resolve(fileURLToPath(new URL("../../../web/dist/", import.meta.url)));
const sourceWebDist = resolve(fileURLToPath(new URL("../../web/dist/", import.meta.url)));
const webDist = existsSync(builtWebDist) ? builtWebDist : sourceWebDist;
const mimeTypes: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8",
};
const store = new Store();
const terminals = new TerminalService(store);
const goAI = new GoAI(store, terminals);
const legacyAI = process.env.LAKE_WEB_AI_RUNTIME === "legacy";
const coordinator = legacyAI ? new Coordinator(store, terminals) : goAI;

async function startAction(action: Action, confirmation?: unknown): Promise<Action> {
  const terminal = store.terminalForAction(action);
  if (!terminal || terminal.holder !== "agent") throw new ApiFailure(409, "Transfer a ready terminal for this resource to the agent before execution");
  const approved = store.decideAction(action.id, "approve", confirmation);
  try {
    const entry = await terminals.execute(approved.sessionId, terminal.id, "agent", approved.command, approved.id);
    void terminals.wait(approved.sessionId, terminal.id, entry.id).then(result => {
      if (result.exitCode === null || store.terminal(approved.sessionId, terminal.id).holder !== "agent") return;
      const goal = store.snapshot(approved.sessionId).messages.filter(item => item.role === "user" && item.createdAt <= approved.createdAt).at(-1)?.text;
      if (!goal || store.session(approved.sessionId).status === "investigating") return;
      store.setSessionStatus(approved.sessionId, "investigating");
      return coordinator.runTurn(approved.sessionId, goal, [], false);
    }).catch(() => { /* Outcome is recorded; never replay. */ });
  } catch {
    store.completeAction(approved.id, "unknown", null);
    throw new ApiFailure(503, "Command could not start; action outcome unknown, inspect before retrying");
  }
  return store.action(approved.id);
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value ?? null));
}

function exactToken(value: string | undefined): boolean {
  if (!value) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authorize(request: IncomingMessage): boolean {
  const bearer = request.headers.authorization?.match(/^Bearer ([^ ]+)$/)?.[1];
  if (exactToken(bearer)) return true;
  const cookie = request.headers.cookie?.split(";").map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return exactToken(cookie);
}

function protectRequest(request: IncomingMessage): void {
  if (!request.headers.host || !expectedHosts.has(request.headers.host)) {
    throw new ApiFailure(403, "Host not allowed");
  }
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) throw new ApiFailure(403, "Origin not allowed");
  // Browsers send Origin for JSON POSTs. Also reject browser no-Origin POSTs based on fetch metadata.
  if (request.method === "POST" && !origin && request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "none") {
    throw new ApiFailure(403, "Origin required");
  }
}

async function body(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new ApiFailure(415, "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiFailure(413, "Request body too large");
    chunks.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiFailure(400, "Invalid JSON body"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiFailure(400, "Expected JSON object");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ApiFailure(400, `${field} must be nonempty text (max ${max} characters)`);
  }
  return value.trim();
}

function sse(request: IncomingMessage, response: ServerResponse, sessionId: string, after: number): void {
  store.session(sessionId);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive", "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  let current = after;
  let blocked = false;
  let closed = false;
  const send = (event: SessionEvent) => {
    if (closed || blocked || event.sessionId !== sessionId || event.seq <= current) return;
    current = event.seq;
    if (!response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
      blocked = true;
      // Slow clients reconnect with their cursor; never retain an unbounded response buffer.
      response.end();
    }
  };
  const unsubscribe = store.onEvent(send);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.on("close", close);
  response.on("close", close);
  const heartbeat = setInterval(() => { if (!closed && !response.write(": heartbeat\n\n")) response.end(); }, 15000);
  heartbeat.unref();
  // Listen first; replay catches writes between snapshot and subscription. seq filters duplicates.
  let cursor = after;
  while (!closed && !blocked) {
    const replay = store.events(sessionId, cursor);
    if (!replay.length) break;
    for (const event of replay) {
      cursor = event.seq;
      send(event);
    }
    if (replay.length < 1000) break;
  }
}

function staticFile(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (!existsSync(webDist)) return false;
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { throw new ApiFailure(400, "Invalid path"); }
  if (pathname.includes("\0") || pathname.includes("\\")) throw new ApiFailure(400, "Invalid path");
  const target = resolve(webDist, "." + normalize(pathname));
  if (target !== webDist && !target.startsWith(webDist + sep)) throw new ApiFailure(403, "Invalid path");
  // A missing application route gets the SPA; missing assets get a real 404.
  const asset = pathname.startsWith("/assets/");
  if (asset && !existsSync(target)) throw new ApiFailure(404, "Asset not found");
  const file = existsSync(target) && statSync(target).isFile() ? target : join(webDist, "index.html");
  if (!existsSync(file)) return false;
  const extension = file.slice(file.lastIndexOf("."));
  response.writeHead(200, { "Content-Type": mimeTypes[extension] || "application/octet-stream", "Cache-Control": "no-store" });
  if (request.method === "HEAD") response.end();
  else createReadStream(file).pipe(response);
  return true;
}

export async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    protectRequest(request);
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    const pathname = url.pathname;
    const method = request.method;
    if (!pathname.startsWith("/api/") && staticFile(request, response, url)) return;
    if (!authorize(request)) {
      if (pathname === "/api/bootstrap" && method === "GET" && generated && process.env.LAKE_WEB_DEV_ORIGIN) {
        response.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`);
      } else {
        throw new ApiFailure(401, "Authentication required");
      }
    } else if (pathname === "/api/bootstrap" && method === "GET") {
      response.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`);
    }
    if (pathname === "/api/bootstrap" && method === "GET") {
      reply(response, 200, {
        authenticated: true, modelConfigured: coordinator.configured(),
        modelName: activeModel()?.name ?? null, supportsImageInput: activeModel()?.supportsImageInput === true, terminalMode: "pty", aiRuntime: legacyAI ? "legacy" : "go",
      });
      return;
    }
    if (pathname === "/api/settings/model/test" && method === "POST") {
      const data = await body(request);
      const protocol = modelProtocol(data.protocol);
      const url = endpointText(data.url, protocol);
      const key = resolveKey(data.apiKey);
      const model = { url, name: modelNameText(data.name), protocol, ...(key ? { key } : {}) };
      const result = legacyAI ? await testModelConnection(model) : await goAI.request<{ok: boolean; message: string}>("testModel", "", model);
      // Say so when the endpoint was completed, so the saved address is not a surprise.
      const typed = typeof data.url === "string" ? data.url.trim() : "";
      reply(response, 200, typed && typed !== url ? { ...result, message: `${result.message}（端点已补全为 ${url}）` } : result);
      return;
    }
    if (pathname === "/api/settings/model/available" && method === "GET") {
      const config = activeModel();
      reply(response, 200, config ? legacyAI ? await listModels(config) : await goAI.request("models", "", config) : { models: [], message: "尚未配置模型" });
      return;
    }
    if (pathname === "/api/settings/model") {
      if (method === "GET") { reply(response, 200, modelSettings()); return; }
      if (method === "PUT") {
        const data = await body(request);
        const key = resolveKey(data.apiKey);
        const protocol = modelProtocol(data.protocol);
        saveModel(endpointText(data.url, protocol), modelNameText(data.name), key, protocol, data.supportsImageInput === undefined ? activeModel()?.supportsImageInput === true : data.supportsImageInput === true, data.supportsImageOutput === undefined ? activeModel()?.supportsImageOutput === true : data.supportsImageOutput === true);
        reply(response, 200, modelSettings());
        return;
      }
      if (method === "DELETE") { clearModel(); reply(response, 200, modelSettings()); return; }
    }
    if (pathname === "/api/catalog" && method === "GET") { reply(response, 200, store.catalog()); return; }
    if (pathname === "/api/projects" && method === "POST") {
      const data = await body(request);
      reply(response, 201, store.createProject(text(data.name, "name", 120)));
      return;
    }
    const projectResources = pathname.match(/^\/api\/projects\/([^/]+)\/resources$/);
    if (projectResources && method === "POST") {
      const data = await body(request);
      if (["database", "docker", "redis"].includes(String(data.kind))) {
        reply(response, 201, store.createServiceResource(projectResources[1]!, text(data.name, "name", 120), data.kind as "database" | "docker" | "redis", data.settings)); return;
      }
      if (data.kind !== "ssh") throw new ApiFailure(400, "Unsupported resource type");
      reply(response, 201, store.createSshResource(projectResources[1]!, text(data.name, "name", 120), data.ssh));
      return;
    }
    const projectSessions = pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
    if (projectSessions && method === "POST") {
      const data = await body(request);
      if (data.resourceIds !== undefined && (!Array.isArray(data.resourceIds) || data.resourceIds.some((value) => typeof value !== "string"))) {
        throw new ApiFailure(400, "resourceIds must be an array of IDs");
      }
      reply(response, 201, store.createSession(projectSessions[1]!, text(data.title, "title", 200),
        data.resourceIds && (data.resourceIds as string[]).length ? data.resourceIds as string[] : undefined));
      return;
    }
    const sessionPath = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionPath && method === "DELETE") {
      const current = store.snapshot(sessionPath[1]!);
      if (current.session.status === "investigating" || current.terminals.some(item => item.status === "busy" || item.status === "connecting")) {
        throw new ApiFailure(409, "该会话正在调查或有命令正在执行，请先等待或中断。");
      }
      if (!legacyAI) { const ai = await goAI.snapshot(sessionPath[1]!); if (["running", "waiting_approval"].includes(ai.status)) throw new ApiFailure(409, "请先停止 AI"); await goAI.request("clear", sessionPath[1]!); }
      terminals.closeSession(sessionPath[1]!);
      store.deleteSession(sessionPath[1]!);
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const snapshot = pathname.match(/^\/api\/sessions\/([^/]+)\/snapshot$/);
    if (snapshot && method === "GET") { const current = store.snapshot(snapshot[1]!); reply(response, 200, { ...current, ...(!legacyAI ? { ai: await goAI.snapshot(snapshot[1]!) } : {}) }); return; }
    const events = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (events && method === "GET") {
      const afterParam = url.searchParams.get("after") ?? request.headers["last-event-id"] ?? "0";
      if (typeof afterParam !== "string" || !/^(0|[1-9]\d*)$/.test(afterParam) || !Number.isSafeInteger(Number(afterParam))) {
        throw new ApiFailure(400, "after must be a nonnegative event cursor");
      }
      sse(request, response, events[1]!, Number(afterParam));
      return;
    }
    if (pathname === "/api/ai/presets") {
      if (method === "GET") { reply(response, 200, await goAI.request("presets")); return; }
      if (method === "POST" || method === "DELETE") { reply(response, 200, await goAI.request(method === "POST" ? "savePreset" : "deletePreset", "", await body(request, 128000))); return; }
    }
    const aiPath = pathname.match(/^\/api\/sessions\/([^/]+)\/ai(?:\/([^/]+))?$/);
    if (aiPath) {
      const sessionId = aiPath[1]!; store.session(sessionId);
      const operation = aiPath[2] || "snapshot";
      if (method === "GET" && operation === "options") { reply(response, 200, store.aiOptions(sessionId)); return; }
      if (method === "GET" && ["snapshot", "history", "tools"].includes(operation)) { reply(response, 200, await goAI.request(operation, sessionId, { ...store.aiOptions(sessionId), ...(operation === "snapshot" ? { before: Number(url.searchParams.get("before")) || 0 } : {}) })); return; }
      if (method === "POST" && operation === "configure") { reply(response, 200, await goAI.configure(sessionId, await body(request, 128000))); return; }
      if (method === "POST" && ["abort", "decision", "clear", "rollback", "compact", "restore", "undoFile", "extractPreset"].includes(operation)) {
        const data = await body(request, operation === "restore" ? 32 * 1024 * 1024 : 128000);
        if (operation !== "abort" && operation !== "decision" && operation !== "extractPreset" && ["investigating", "waiting_approval"].includes(store.session(sessionId).status)) throw new ApiFailure(409, "AI 正在运行，请先停止");
        if (["extractPreset", "compact", "undoFile"].includes(operation)) await goAI.configure(sessionId);
        reply(response, 200, await goAI.request(operation, sessionId, data)); store.touchAI(sessionId); return;
      }
    }
    const imagePath = pathname.match(/^\/api\/sessions\/([^/]+)\/messages\/([^/]+)\/images\/([^/]+)$/);
    if (imagePath && method === "GET") {
      const image = store.image(imagePath[1]!, imagePath[2]!, imagePath[3]!);
      response.writeHead(200, { "Content-Type": image.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" }); response.end(Buffer.from(image.base64, "base64")); return;
    }
    const messages = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (messages && method === "POST") {
      const data = await body(request, 8 * 1024 * 1024);
      if (data.resourceIds !== undefined && (!Array.isArray(data.resourceIds) || data.resourceIds.some((value) => typeof value !== "string"))) {
        throw new ApiFailure(400, "resourceIds must be an array of IDs");
      }
      // @-mentions from the composer: every referenced resource must belong to this session.
      const mentioned = [...new Set((data.resourceIds as string[] | undefined) ?? [])];
      for (const resourceId of mentioned) store.assertSessionResource(messages[1]!, resourceId);
      if (!legacyAI && store.session(messages[1]!).status === "waiting_approval" && (await goAI.snapshot(messages[1]!)).pending) throw new ApiFailure(409, "请先处理本轮审批，或停止本轮");
      let images: AIImage[] = [];
      if (data.images !== undefined) {
        if (legacyAI || !activeModel()?.supportsImageInput) throw new ApiFailure(400, "所选模型未启用图片输入能力");
        images = await goAI.request<AIImage[]>("validateImages", "", { images: data.images });
      }
      const references = inputReferences(store, messages[1]!, data.references);
      const message = store.beginInvestigation(messages[1]!, text(data.text, "text", 100000), images);
      const resources = mentioned.map((resourceId) => { const item = store.resource(resourceId); return { id: item.id, name: item.name, status: item.status }; });
      setImmediate(() => { void (coordinator instanceof GoAI ? coordinator.runTurn(messages[1]!, message.text, resources, true, images, references) : coordinator.runTurn(messages[1]!, message.text, resources)).catch(() => {
        store.addMessage(messages[1]!, "system", "Investigation stopped due to an internal error; no model result was applied.");
        store.setSessionStatus(messages[1]!, "failed");
      }); });
      reply(response, 202, message);
      return;
    }
    const decisions = pathname.match(/^\/api\/actions\/([^/]+)\/decision$/);
    if (decisions && method === "POST") {
      const data = await body(request);
      if (data.decision !== "approve" && data.decision !== "reject") throw new ApiFailure(400, "decision must be approve or reject");
      const action = store.action(decisions[1]!);
      if (action.status !== "pending") throw new ApiFailure(409, "Action already decided");
      if (data.decision === "approve") {
        reply(response, 202, await startAction(action, data.confirmation));
      } else reply(response, 200, store.decideAction(action.id, "reject"));
      return;
    }
    const createTerminal = pathname.match(/^\/api\/sessions\/([^/]+)\/terminals$/);
    if (createTerminal && method === "POST") {
      const data = await body(request);
      reply(response, 201, await terminals.open(createTerminal[1]!, text(data.resourceId, "resourceId", 100)));
      return;
    }
    const terminalPath = pathname.match(/^\/api\/sessions\/([^/]+)\/terminals\/([^/]+)\/(history|control|commands|interrupt|input|resize|disconnect)$/);
    if (terminalPath) {
      const [, sessionId, terminalId, kind] = terminalPath;
      if (kind === "history" && method === "GET") { reply(response, 200, store.history(sessionId!, terminalId!)); return; }
      if (kind === "control" && method === "POST") {
        const data = await body(request);
        if (data.holder !== "user" && data.holder !== "agent" && data.holder !== null) {
          throw new ApiFailure(400, "holder must be user, agent, or null");
        }
        const controlled = terminals.control(sessionId!, terminalId!, data.holder);
        if (data.holder === "agent") {
          const pending = store.snapshot(sessionId!).actions.find(action => action.status === "pending" && action.risk === "readonly" && action.resourceId === controlled.resourceId && (!action.terminalId || action.terminalId === controlled.id));
          if (pending) await startAction(pending);
        }
        reply(response, 200, store.terminal(sessionId!, terminalId!));
        return;
      }
      if (kind === "input" && method === "POST") {
        const data = await body(request);
        if (typeof data.data !== "string") throw new ApiFailure(400, "data must be text");
        terminals.input(sessionId!, terminalId!, data.data);
        reply(response, 202, { accepted: true });
        return;
      }
      if (kind === "resize" && method === "POST") {
        const data = await body(request);
        terminals.resize(sessionId!, terminalId!, Number(data.cols), Number(data.rows));
        reply(response, 200, { resized: true });
        return;
      }
      if (kind === "disconnect" && method === "POST") {
        terminals.close(sessionId!, terminalId!);
        reply(response, 200, { disconnected: true });
        return;
      }
      if (kind === "interrupt" && method === "POST") {
        terminals.interrupt(sessionId!, terminalId!);
        reply(response, 202, { interrupted: true });
        return;
      }
      if (kind === "commands" && method === "POST") {
        const data = await body(request);
        if (data.actor !== "user" && data.actor !== "agent") throw new ApiFailure(400, "actor must be user or agent");
        if (!validCommand(data.command)) throw new ApiFailure(400, "command must be one nonempty line (max 2000 characters)");
        // Model actions can only execute via frozen, single-use action approvals, not this user composer.
        if (data.actor === "agent") throw new ApiFailure(403, "Agent commands require action approval");
        const policy = commandPolicy(data.command);
        if (policy.risk !== "readonly" && data.confirmed !== true) throw new ApiFailure(400, "State-changing command requires confirmation");
        const resource = store.resource(store.terminal(sessionId!, terminalId!).resourceId);
        if (policy.risk === "dangerous" && data.confirmation !== dangerConfirmation(resource.name)) throw new ApiFailure(400, "Dangerous command requires explicit target confirmation");
        reply(response, 202, await terminals.execute(sessionId!, terminalId!, "user", data.command));
        return;
      }
    }
    if (pathname.startsWith("/api/")) throw new ApiFailure(404, "API route not found");
    throw new ApiFailure(404, "Page not found");
  } catch (error) {
    if (response.headersSent) { response.end(); return; }
    const failure = error instanceof ApiFailure ? error : new ApiFailure(500, "Internal server error");
    reply(response, failure.status, { error: failure.message });
  }
}

export function startServer(): ReturnType<typeof createServer> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid LAKE_WEB_PORT");
  const server = createServer((request, response) => { void route(request, response); });
  server.listen(port, host, () => {
    console.log(`Lake Web Agent listening at http://localhost:${port}`);
    if (generated && process.env.LAKE_WEB_START_OPEN !== "1") console.log(`Generated startup access token: ${token}`);
    if (process.env.LAKE_WEB_START_OPEN === "1") {
      const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [`http://localhost:${port}/#token=${encodeURIComponent(token)}`], { stdio: "ignore" });
      child.on("error", () => { console.log(`Open http://localhost:${port} and use the startup access token`); }); child.unref();
    }
  });
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
    goAI.shutdown();
    terminals.shutdown();
    server.close(() => { store.close(); process.exit(0); });
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
