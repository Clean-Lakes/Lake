import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { AvailableModels, ModelSettings, ModelTestResult } from "../../shared/contracts.js";
import { ApiFailure, dataDirectory } from "./store.js";

export type ModelConfig = { url: string; name: string; key?: string; protocol?: string; supportsImageInput?: boolean; supportsImageOutput?: boolean };

const MAX_URL = 2000;
const MAX_NAME = 200;
const MAX_KEY = 4096;
const TEST_TIMEOUT_MS = 15000;
const LIST_TIMEOUT_MS = 10000;

function configFile(): string {
  return join(dataDirectory(), "model.json");
}

export const MODEL_PROTOCOLS = ["openai", "azure-gpt", "openai-response", "claude", "gemini", "ollama"];
export function modelProtocol(value: unknown): string { if (value === undefined) return "openai"; if (typeof value !== "string" || !MODEL_PROTOCOLS.includes(value)) throw new ApiFailure(400, "Invalid model protocol"); return value; }
export function endpointText(value: unknown, protocol = "openai"): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_URL) {
    throw new ApiFailure(400, `url must be an http(s) endpoint (max ${MAX_URL} characters)`);
  }
  const trimmed = value.trim();
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new ApiFailure(400, "url must be an absolute http(s) URL"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new ApiFailure(400, "url must use http or https");
  // People paste base URLs (`…/v1`, or just a host). Complete the conventional
  // chat-completions path instead of failing later with an opaque HTTP 404.
  if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some(k => /key|token|secret/i.test(k))) throw new ApiFailure(400, "Use the separate credential field");
  const path = parsed.pathname.replace(/\/+$/, "");
  if (protocol !== "openai" && protocol !== "azure-gpt") {
    if (!path || /^\/v\d+$/.test(path)) parsed.pathname = protocol === "ollama" ? "/api/chat" : `${path || "/v1"}/${protocol === "claude" ? "messages" : protocol === "openai-response" ? "responses" : "models/{model}:streamGenerateContent"}`;
    return parsed.toString();
  }
  if (/\/chat\/completions$/.test(path)) return trimmed;
  if (!path) parsed.pathname = "/v1/chat/completions";
  else if (/\/v\d+$/.test(path)) parsed.pathname = `${path}/chat/completions`;
  else return trimmed;
  return parsed.toString();
}

export function modelNameText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_NAME) {
    throw new ApiFailure(400, `name must be nonempty text (max ${MAX_NAME} characters)`);
  }
  return value.trim();
}

/** An empty or null key is valid: some endpoints run without authentication. */
export function modelKeyText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > MAX_KEY) throw new ApiFailure(400, `apiKey must be text (max ${MAX_KEY} characters)`);
  return value.trim() ? value : undefined;
}

function parse(value: unknown): ModelConfig | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  try {
    let key = modelKeyText(item.key);
    if (typeof item.credentialRef === "string") {
      const root = realpathSync(join(process.env.LAKE_HOME || join(homedir(), ".lake"), "secrets"));
      const file = realpathSync(join(root, item.credentialRef));
      const info = statSync(file);
      if (!file.startsWith(root + "/") || !info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) return null;
      key = modelKeyText(readFileSync(file, "utf8"));
    }
    const protocol = modelProtocol(item.protocol);
    return { url: endpointText(item.url, protocol), name: modelNameText(item.name), protocol, supportsImageInput: item.supportsImageInput === true, supportsImageOutput: item.supportsImageOutput === true, ...(key ? { key } : {}) };
  } catch { return null; }
}

/** Settings saved from the interface. The key never leaves the server. */
export function savedModel(): ModelConfig | null {
  const path = configFile();
  if (!existsSync(path)) return null;
  try { return parse(JSON.parse(readFileSync(path, "utf8"))); }
  catch { return null; }
}

/** Startup environment variables are the fallback for installs without saved settings. */
export function environmentModel(): ModelConfig | null {
  if (!process.env.LAKE_WEB_MODEL_URL || !process.env.LAKE_WEB_MODEL_NAME) return null;
  try {
    return {
      url: endpointText(process.env.LAKE_WEB_MODEL_URL, modelProtocol(process.env.LAKE_WEB_MODEL_PROTOCOL)), protocol: modelProtocol(process.env.LAKE_WEB_MODEL_PROTOCOL), supportsImageInput: process.env.LAKE_WEB_MODEL_IMAGE_INPUT === "1", supportsImageOutput: process.env.LAKE_WEB_MODEL_IMAGE_OUTPUT === "1", name: modelNameText(process.env.LAKE_WEB_MODEL_NAME),
      ...(process.env.LAKE_WEB_MODEL_KEY ? { key: process.env.LAKE_WEB_MODEL_KEY } : {}),
    };
  } catch { return null; }
}

/** Saved settings win; a configured file replaces the environment entirely. */
export function activeModel(): ModelConfig | null {
  return savedModel() ?? environmentModel();
}

export function modelSettings(): ModelSettings {
  const active = activeModel();
  return {
    source: savedModel() ? "settings" : environmentModel() ? "environment" : "none",
    configured: active !== null,
    url: active?.url ?? "",
    name: active?.name ?? "",
    keyConfigured: Boolean(active?.key),
    protocol: active?.protocol ?? "openai",
    supportsImageInput: active?.supportsImageInput === true,
    supportsImageOutput: active?.supportsImageOutput === true,
  };
}

/** Writes the file with private permissions inside the private data directory. */
export function saveModel(url: string, name: string, key?: string, protocol = "openai", supportsImageInput = false, supportsImageOutput = false): void {
  const dir = dataDirectory();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = configFile();
  let previous: string | undefined;
  try { const old = JSON.parse(readFileSync(path, "utf8")) as { credentialRef?: string }; previous = old.credentialRef; } catch {}
  const secrets = join(process.env.LAKE_HOME || join(homedir(), ".lake"), "secrets");
  let credentialRef: string | undefined;
  if (key) {
    mkdirSync(secrets, { recursive: true, mode: 0o700 }); chmodSync(secrets, 0o700);
    credentialRef = `web-model-${randomUUID()}.key`;
    writeFileSync(join(secrets, credentialRef), key, { mode: 0o600, flag: "wx" });
  }
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, `${JSON.stringify({ url, name, protocol, supportsImageInput, supportsImageOutput, ...(credentialRef ? { credentialRef } : {}) }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(staging, path);
  } catch (error) { if (credentialRef) rmSync(join(secrets, credentialRef), { force: true }); throw error; }
  finally { rmSync(staging, { force: true }); }
  if (previous && /^web-model-[0-9a-f-]+\.key$/.test(previous)) rmSync(join(secrets, previous), { force: true });
  chmodSync(path, 0o600);
}

export function clearModel(): void {
  rmSync(configFile(), { force: true });
}

/**
 * Resolves the key for a save request. Omitting apiKey keeps whatever credential is
 * currently in effect so editing the endpoint or model name never drops a working key;
 * passing null or an empty string removes it.
 */
export function resolveKey(next: unknown): string | undefined {
  if (next === undefined) return activeModel()?.key;
  if (next === null) return undefined;
  return modelKeyText(next);
}

/** Secrets that must never reach recorded command output or model messages. */
export function activeSecrets(): string[] {
  const key = activeModel()?.key;
  return key ? [key] : [];
}

/**
 * One minimal chat-completions call so the interface can tell the user whether the
 * endpoint, model name and key actually work — before any investigation depends on them.
 * The reply never contains the key.
 */
/**
 * Reads the endpoint's model list (the OpenAI-compatible `GET /models`) so the
 * composer can offer a switcher instead of a free-text field. Failure is a normal
 * outcome: many gateways do not expose the route.
 */
export async function listModels(config: ModelConfig): Promise<AvailableModels> {
  const url = config.url.replace(/\/chat\/completions$/, "/models");
  if (url === config.url) return { models: [], message: "此端点不是标准路径，无法推断模型列表接口；可在模型设置中手动填写模型名" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) },
    });
    if (!response.ok) return { models: [], message: `模型列表接口返回 HTTP ${response.status}` };
    const payload = await response.json().catch(() => null) as { data?: Array<{ id?: unknown }> } | null;
    const models = Array.isArray(payload?.data)
      ? payload.data.map((item) => item?.id).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200).slice(0, 200)
      : [];
    return models.length ? { models } : { models: [], message: "端点没有返回可用的模型列表；可在模型设置中手动填写模型名" };
  } catch {
    return { models: [], message: controller.signal.aborted ? "获取模型列表超时；可在模型设置中手动填写模型名" : "无法连接端点获取模型列表；可在模型设置中手动填写模型名" };
  } finally { clearTimeout(timeout); }
}

export async function testModelConnection(config: ModelConfig): Promise<ModelTestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const response = await fetch(config.url, {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) },
      body: JSON.stringify({
        model: config.name, stream: false, temperature: 0, max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? "：密钥无效或没有权限"
        : response.status === 404 ? "：端点路径或模型名可能不存在"
        : response.status === 429 ? "：请求过于频繁或额度不足" : "";
      return { ok: false, message: `端点返回 HTTP ${response.status}${hint}` };
    }
    const envelope = await response.json().catch(() => null) as { choices?: unknown } | null;
    if (!envelope || !Array.isArray(envelope.choices) || !envelope.choices.length) {
      return { ok: false, message: "端点有响应，但不是可识别的 Chat Completions 格式" };
    }
    return { ok: true, message: "连接成功，模型返回了有效响应" };
  } catch {
    return { ok: false, message: controller.signal.aborted ? `请求超时（${TEST_TIMEOUT_MS / 1000} 秒）` : "无法连接端点；请检查 URL、网络或代理" };
  } finally { clearTimeout(timeout); }
}
