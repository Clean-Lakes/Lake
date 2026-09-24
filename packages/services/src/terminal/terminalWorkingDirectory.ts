import { statSync } from "node:fs";
import { homedir } from "node:os";

function isUsableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function resolveTerminalCwd(cwd?: string): string {
  // 工作区可能已经移动或删除；仅把存在的目录交给 node-pty，避免启动失败。
  const candidates = [cwd, process.env.HOME, homedir(), "/"];

  for (const candidate of candidates) {
    if (candidate && isUsableDirectory(candidate)) return candidate;
  }

  throw new Error("No usable working directory found for terminal startup");
}
