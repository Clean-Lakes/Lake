import type { JsonValue } from "./json.js";
import { object, redact, type Params } from "./validation.js";

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
export function fields(value: Params, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("展示数据包含未知字段");
}
export function boundedJSON(value: JsonValue, depth = 0): void {
  if (depth > 8) throw new Error("展示数据超过 8 层");
  if (typeof value === "string" && new TextEncoder().encode(value).length > 16384) throw new Error("展示文字过长");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("展示数值无效");
  if (Array.isArray(value)) {
    if (value.length > 200) throw new Error("展示列表超过 200 行");
    value.forEach(item => boundedJSON(item, depth + 1));
  } else if (value && typeof value === "object") {
    if (Object.keys(value).length > 64) throw new Error("展示对象字段过多");
    for (const [key, child] of Object.entries(value)) { if (FORBIDDEN.has(key) || key.length > 96) throw new Error("不允许的展示数据键"); boundedJSON(child, depth + 1); }
  }
}
export function cleanJSON(value: JsonValue): JsonValue {
  if (typeof value === "string") return redact(value, 16384);
  if (Array.isArray(value)) return value.map(cleanJSON);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, /password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization/iu.test(key) ? "[redacted]" : cleanJSON(child)]));
  return value;
}
export function pointer(value: string): string[] {
  if (!value.startsWith("/") || value.length > 256) throw new Error("绑定须使用有界 JSON Pointer");
  const parts = value.slice(1).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts.length > 8 || parts.some(part => !part || FORBIDDEN.has(part))) throw new Error("数据路径无效"); return parts;
}
export function boundValue(value: JsonValue, data: Params): JsonValue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const binding = object(value); fields(binding, ["path"]);
  let current: JsonValue | undefined = data;
  for (const part of pointer(String(binding.path))) { if (!current || typeof current !== "object" || Array.isArray(current)) return undefined; current = current[part]; }
  return current;
}
