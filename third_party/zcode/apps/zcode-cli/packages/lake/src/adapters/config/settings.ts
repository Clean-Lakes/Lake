import { join } from "node:path";
import type { JsonValue } from "../../domain/json.js";
import { hasControl, integer, name, object, text, type Params } from "../../domain/validation.js";
import type { SettingsPort } from "../../app/ports.js";
import { FileVault } from "../vault.js";
import { atomicFile, readModelConfig, readSettings, saveModelConfig, secureURL, validIdentifier } from "./files.js";

export class LakeSettings implements SettingsPort {
  constructor(private readonly root: string, private readonly vault: FileVault) {}
  async request(p: Params): Promise<JsonValue> {
    const settings = await readSettings(this.root), config = await readModelConfig(this.root);
    const action = text(p, "action", "get"), catalog = object(config.model_catalog), providers = object(config.model_providers);
    switch (action) {
      case "get": {
        const models = await Promise.all(Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)).map(async ([model, provider]) => {
          const spec = object(providers[String(provider)]);
          return { name: model, provider, base_url: spec.base_url ?? "", wire_api: spec.wire_api ?? "anthropic", has_key: await this.vault.has("model", String(provider)), context_window: config.context_window ?? 32000, max_output_tokens: config.max_output_tokens ?? 4096 };
        }));
        const mcp = (settings.mcp as Params[]).map(server => { const view = { ...server }; delete view.secret_ref; delete view.env; delete view.headers; return view; });
        return { current_model: config.model ?? "", models, prompts: settings.prompts, descriptions: settings.descriptions, mcp, specialists: settings.specialists };
      }
      case "model_save": {
        const model = name(text(p, "model")), provider = validIdentifier(text(p, "provider"));
        if (catalog[model] && catalog[model] !== provider) throw new Error("同名模型不能改用其他提供方");
        const wire = text(p, "wire_api", "anthropic");
        if (!["anthropic", "openai_chat", "openai_responses"].includes(wire)) throw new Error("无效的模型协议");
        providers[provider] = { base_url: secureURL(text(p, "base_url")), wire_api: wire };
        catalog[model] = provider;
        const window = integer(p, "context_window", Number(config.context_window ?? 32000)), output = integer(p, "max_output_tokens", Number(config.max_output_tokens ?? 4096));
        if (window < 1024 || window > 1_000_000 || output < 1 || output >= window) throw new Error("模型 Token 配置无效");
        config.context_window = window; config.max_output_tokens = output;
        if (!config.model) { config.model = model; config.model_provider = provider; }
        const key = text(p, "api_key");
        if (key) await this.vault.put("model", provider, Buffer.from(key));
        await saveModelConfig(this.root, config); return null;
      }
      case "model_delete": case "model_use": {
        const model = text(p, "model");
        if (!catalog[model]) throw new Error("模型不存在");
        if (action === "model_delete") {
          delete catalog[model];
          if (config.model === model) { config.model = Object.keys(catalog).sort()[0] ?? ""; config.model_provider = catalog[String(config.model)] ?? ""; }
        } else { config.model = model; config.model_provider = catalog[model]; }
        await saveModelConfig(this.root, config); return null;
      }
      case "prompt_save": {
        const target = text(p, "name");
        if (!["lake", "ssh", "code"].includes(target) || text(p, "prompt").length > 16000 || text(p, "description").length > 500) throw new Error("无效的专员提示");
        object(settings.prompts)[target] = text(p, "prompt").trim(); object(settings.descriptions)[target] = text(p, "description").trim(); break;
      }
      case "specialist_save": case "specialist_delete": {
        const specialist = object(p.specialist), target = action === "specialist_save" ? name(text(specialist, "name")) : text(p, "name");
        const specialists = settings.specialists as Params[], index = specialists.findIndex(item => item.name === target);
        if (action === "specialist_delete") { if (index < 0) throw new Error("专员不存在"); specialists.splice(index, 1); }
        else {
          if (!text(specialist, "description") || !text(specialist, "instruction") || text(specialist, "instruction").length > 16000) throw new Error("专员描述或指令无效");
          if (index >= 0) specialists[index] = specialist;
          else { if (specialists.length >= 32) throw new Error("专员数量超过 32"); specialists.push(specialist); }
        }
        break;
      }
      case "mcp_save": {
        const server = { ...object(p.server) }, target = validIdentifier(text(server, "name")), transport = text(server, "transport");
        if (target.startsWith("plugin_")) throw new Error("plugin_ 是保留前缀");
        if (transport === "stdio") { if (!text(server, "command").trim()) throw new Error("请填写 MCP 命令"); delete server.url; delete server.headers; }
        else if (transport === "http") { secureURL(text(server, "url"), true); delete server.command; delete server.args; delete server.env; }
        else throw new Error("未知的 MCP 传输方式");
        const servers = settings.mcp as Params[], index = servers.findIndex(item => item.name === target);
        const previous = p.clear_secrets === true || !(await this.vault.has("mcp", target)) ? {} : object(JSON.parse((await this.vault.load("mcp", target)).toString()));
        const secrets: Params = transport === "stdio" ? { env: server.env ?? previous.env ?? {} } : { headers: server.headers ?? previous.headers ?? {} };
        for (const key of Object.keys(object(secrets.env))) if (!key.trim() || key.includes("=") || hasControl(key)) throw new Error("无效的环境变量名");
        for (const key of Object.keys(object(secrets.headers))) if (!key.trim() || key.includes(":") || hasControl(key)) throw new Error("无效的请求头名");
        await this.vault.put("mcp", target, Buffer.from(JSON.stringify(secrets)));
        delete server.env; delete server.headers; server.secret_ref = target;
        if (index < 0) servers.push(server); else servers[index] = server;
        servers.sort((a, b) => String(a.name).localeCompare(String(b.name))); break;
      }
      case "mcp_delete": {
        const servers = settings.mcp as Params[], index = servers.findIndex(item => item.name === p.name);
        if (index < 0) throw new Error("MCP 服务不存在");
        servers.splice(index, 1); await this.vault.delete("mcp", text(p, "name")); break;
      }
      default: throw new Error(`未知的设置操作 ${action}`);
    }
    await atomicFile(join(this.root, "settings.json"), JSON.stringify(settings, null, 2)); return null;
  }
}
