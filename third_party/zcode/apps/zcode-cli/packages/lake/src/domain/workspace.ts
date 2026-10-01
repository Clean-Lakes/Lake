import { hasControl } from "./validation.js";

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_GIT_BYTES = 64 * 1024;
export const IGNORED_DIRECTORIES = new Set(["node_modules", ".next", ".venv", "vendor", "dist", "build", "coverage", ".cache"]);
export function sensitivePath(path: string): boolean {
  return path.replaceAll("\\", "/").split("/").some(part => {
    const lower = part.toLowerCase();
    return [".git", ".lake", ".ssh", "secrets", "id_rsa", "id_ed25519", ".env"].includes(lower) || (lower.startsWith(".env.") && !lower.endsWith(".example")) || lower.endsWith(".pem") || lower.endsWith(".key");
  });
}
export function workspaceRelative(value: string): string {
  if (!value || value.length > 1024 || hasControl(value) || value.includes("\\") || value.startsWith("/") || /^[a-z]:/iu.test(value) || value.split("/").some(part => !part || part === "." || part === "..") || sensitivePath(value)) throw new Error("路径超出代码项目或属于敏感文件");
  return value;
}
export function terminalCommand(value: string): string {
  if (!value.trim() || value.length > 4000 || hasControl(value)) throw new Error("终端命令须为不超过 4000 字符的单行文本");
  return value;
}
export const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";
