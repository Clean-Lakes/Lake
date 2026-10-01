import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse, stringify } from "smol-toml";
import type { Params } from "../../domain/validation.js";
import { object, text } from "../../domain/validation.js";
import { privateDirectory } from "../storage/database.js";

export async function atomicFile(path: string, content: string | Uint8Array): Promise<void> {
  await privateDirectory(dirname(path));
  const temporary = join(dirname(path), `.lake-write-${randomBytes(16).toString("hex")}`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(content); await file.sync(); await file.close(); await rename(temporary, path);
  } catch (error) { await file.close().catch(() => {}); throw error; }
  finally { await rm(temporary, { force: true }); }
}
export async function optionalFile(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
export async function readModelConfig(root: string): Promise<Params> {
  const raw = await optionalFile(join(root, "config.toml"));
  const config = raw ? parse(raw) as Params : {};
  const providers = object(config.model_providers), catalog = object(config.model_catalog);
  if (config.model && config.model_provider && !catalog[String(config.model)]) catalog[String(config.model)] = config.model_provider;
  return { ...config, model_providers: providers, model_catalog: catalog };
}
export async function saveModelConfig(root: string, config: Params): Promise<void> {
  await atomicFile(join(root, "config.toml"), stringify(config));
}
export async function readSettings(root: string): Promise<Params> {
  const raw = await optionalFile(join(root, "settings.json")), settings = raw ? object(JSON.parse(raw)) : {};
  return { ...settings, prompts: object(settings.prompts), descriptions: object(settings.descriptions), mcp: settings.mcp ?? [], specialists: settings.specialists ?? [] };
}
export function secureURL(value: string, local = false): string {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error("地址必须使用 HTTPS，且不能包含认证或查询参数");
  return value;
}
export function validIdentifier(value: string): string {
  if (!/^[a-z0-9_-]{1,128}$/u.test(value)) throw new Error("名称只能使用小写字母、数字、- 或 _");
  return value;
}
export function selectedProvider(config: Params): Params {
  const provider = object(object(config.model_providers)[text(config, "model_provider")]);
  if (!config.model || !provider.base_url) throw new Error("模型尚未配置；请运行 lake model configure");
  return provider;
}
