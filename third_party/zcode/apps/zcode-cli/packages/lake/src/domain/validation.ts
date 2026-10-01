import type { JsonValue } from "./json.js";

export type Params = Record<string, JsonValue>;
export type View = Record<string, JsonValue>;
export function hasControl(value: string, allowLineBreaks = false): boolean {
  return Array.from(value).some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 && !(allowLineBreaks && (code === 9 || code === 10));
  });
}
export const text = (p: Params, key: string, fallback = ""): string => {
  const value = p[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`无效的 ${key}`);
  return value;
};
export const integer = (p: Params, key: string, fallback = 0): number => {
  const value = p[key] ?? fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`无效的 ${key}`);
  return value;
};
export function name(value: string): string {
  if (!value.trim() || value.length > 128 || hasControl(value) || /[/\\]/u.test(value)) throw new Error("无效的名称");
  return value.trim();
}
export function object(value: JsonValue | undefined): Params {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("无效的对象");
  return value;
}
export function parseObject(value: string): Params { return object(JSON.parse(value) as JsonValue); }
export function remoteRoot(value: string): string {
  if (!value.startsWith("/") || value === "/" || value.length > 1024 || hasControl(value) || value.includes("\\") || value.split("/").slice(1).some(part => !part || part === "." || part === "..")) throw new Error("远程根目录必须是规范绝对路径");
  return value;
}
export function command(value: string): string {
  if (!value.trim() || value.length > 2048 || hasControl(value, true)) throw new Error("命令为空、过长或含控制字符");
  if (/(?:rm\s+-[^\s]*r[^\s]*f\s+\/(?:\s|$)|mkfs\b|\b(?:shutdown|reboot|poweroff)\b|dd\s+if=|(?:curl|wget)[^\n]*\|\s*(?:sh|bash))/iu.test(value)) throw new Error("命令被危险操作规则阻止");
  return value;
}
export const FIXED_READ_CHECKS: Readonly<Record<string, string>> = {
  hostname: "hostname", uptime: "uptime", os: "uname -a", disk: "df -hP", memory: "free -h",
  cpu: "awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat; sleep 1; awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat",
};
export function redact(value: string, limit = 16384): string {
  if (/-----BEGIN[^\n]*(?:PRIVATE KEY)|(?:authorization\s*[:=]\s*(?:bearer|basic))/iu.test(value)) return "[redacted]";
  const safe = value.replace(/sk-[a-z0-9_-]{12,}|(?:api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/giu, "[redacted]");
  return safe.length > limit ? safe.slice(0, limit) + "\n…（输出已截断）" : safe;
}
