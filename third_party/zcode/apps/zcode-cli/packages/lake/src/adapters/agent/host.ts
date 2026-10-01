import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import type { LakeTool } from "../../domain/agent.js";
import type { JsonValue } from "../../domain/json.js";
import { object, text, type Params } from "../../domain/validation.js";
import { AgentToolCalls } from "./tool-calls.js";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export interface AgentHostOptions {
  tools: LakeTool[];
  apiKey: Buffer;
  provider: Params;
  signal: AbortSignal;
  nativeTools?: boolean;
  maxModelRequests?: number;
}
export async function requestBody(request: IncomingMessage): Promise<Params> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
async function forwardModel(
  request: IncomingMessage,
  response: ServerResponse,
  options: AgentHostOptions,
): Promise<void> {
  const wire = text(options.provider, "wire_api", "anthropic"),
    path = (request.url ?? "").slice("/model".length);
  const routes =
    wire === "anthropic"
      ? ["/v1/messages", "/messages"]
      : wire === "openai_chat"
        ? ["/chat/completions"]
        : wire === "openai_responses"
          ? ["/responses"]
          : [];
  if (!routes.includes(path)) {
    json(response, { error: "unsupported model route" }, 403);
    return;
  }
  const payload = await requestBody(request),
    tools = payload.tools ?? [],
    allowed = new Set(options.tools.map((tool) => `mcp__lake__${tool.name}`));
  if (
    !Array.isArray(tools) ||
    tools.some((tool) => {
      const name = text(object(tool), "name", text(object(object(tool).function), "name"));
      return !allowed.has(name) && (!options.nativeTools || name.startsWith("mcp__lake__"));
    })
  ) {
    json(response, { error: "unregistered tool" }, 403);
    return;
  }
  const base = new URL(text(options.provider, "base_url"));
  if (
    !["https:", "http:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("无效的模型地址");
  const suffix = wire === "anthropic" ? "/v1/messages" : "/v1" + path;
  const prefix = base.pathname.replace(/\/+$/u, "");
  // 已含协议路径或 /v1 的旧配置不能再拼接一次，否则请求落到错误端点。
  base.pathname = prefix.endsWith(suffix)
    ? prefix
    : prefix.endsWith("/v1")
      ? prefix + suffix.slice(3)
      : prefix + suffix;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream, application/json",
  };
  if (wire === "anthropic") {
    headers["x-api-key"] = options.apiKey.toString();
    headers["anthropic-version"] = "2023-06-01";
  } else headers.authorization = "Bearer " + options.apiKey.toString();
  const upstream = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: options.signal,
    redirect: "error",
  });
  if (!upstream.ok || !upstream.body) {
    json(response, { error: "模型请求失败", status: upstream.status }, upstream.status);
    await upstream.body?.cancel();
    return;
  }
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-cache",
  });
  const key = options.apiKey.toString(),
    decoder = new TextDecoder();
  let pending = "";
  const write = async (value: string) => {
    if (!response.write(value.replaceAll(key, "[redacted]")))
      await once(response, "drain", { signal: options.signal });
  };
  for await (const chunk of upstream.body) {
    pending += decoder.decode(chunk, { stream: true });
    let end = Math.max(0, pending.length - key.length + 1),
      match = pending.indexOf(key);
    while (match >= 0 && match < end) {
      if (match + key.length > end) {
        end = match;
        break;
      }
      match = pending.indexOf(key, match + key.length);
    }
    if (end) {
      await write(pending.slice(0, end));
      pending = pending.slice(end);
    }
  }
  pending += decoder.decode();
  await write(pending);
  response.end();
}
export async function createAgentHost(options: AgentHostOptions) {
  const token = randomBytes(32).toString("hex"),
    expected = Buffer.from(`Bearer ${token}`);
  let calls = new AgentToolCalls(options.tools, options.apiKey, options.signal),
    modelRequests = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const authorization = Buffer.from(request.headers.authorization ?? "");
      if (
        request.method !== "POST" ||
        authorization.length !== expected.length ||
        !timingSafeEqual(authorization, expected)
      ) {
        json(response, { error: "unauthorized" }, 403);
        return;
      }
      if (request.url?.startsWith("/model/")) {
        if (options.maxModelRequests !== undefined && ++modelRequests > options.maxModelRequests) {
          json(response, { error: "model turn budget exhausted" }, 403);
          return;
        }
        await forwardModel(request, response, options);
        return;
      }
      if (request.url !== "/mcp") {
        json(response, { error: "not found" }, 404);
        return;
      }
      const message = await requestBody(request),
        method = text(message, "method"),
        params = object(message.params);
      if (message.id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      let result: JsonValue;
      if (method === "initialize")
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "lake-typescript", version: "1" },
        };
      else if (method === "ping") result = {};
      else if (method === "tools/list")
        result = {
          tools: options.tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        };
      else if (method === "tools/call") {
        result = await calls.call(message.id, params);
      } else {
        json(response, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
        return;
      }
      json(response, { jsonrpc: "2.0", id: message.id, result });
    })().catch(() => {
      if (!response.headersSent) json(response, { error: "Lake gateway request failed" }, 502);
      else response.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 0;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法建立本地 Lake gateway");
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    configure: (tools: LakeTool[], signal: AbortSignal) => {
      options.tools = tools;
      options.signal = signal;
      calls = new AgentToolCalls(tools, options.apiKey, signal);
      modelRequests = 0;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
