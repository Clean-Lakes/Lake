import { constants } from "node:fs";
import { lstat, open, realpath, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { View } from "../../domain/validation.js";
import { redact } from "../../domain/validation.js";
import { IGNORED_DIRECTORIES, MAX_FILE_BYTES, sensitivePath, workspaceRelative } from "../../domain/workspace.js";

export async function registeredRoot(root: string): Promise<string> {
  if (!isAbsolute(root) || sensitivePath(root) || await realpath(root) !== root || !(await stat(root)).isDirectory()) throw new Error("代码项目路径已变化或不可访问");
  return root;
}
export async function projectFile(root: string, value: string): Promise<string> {
  workspaceRelative(value); await registeredRoot(root);
  const path = await realpath(resolve(root, value)), rel = relative(root, path);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel) || sensitivePath(rel)) throw new Error("符号链接超出项目或指向敏感文件");
  return path;
}
export async function readText(root: string, value: string, limit = MAX_FILE_BYTES): Promise<string> {
  const path = await projectFile(root, value), file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat(), fresh = await lstat(path);
    if (!info.isFile() || fresh.isSymbolicLink() || info.ino !== fresh.ino || info.dev !== fresh.dev || info.size > limit || await projectFile(root, value) !== path) throw new Error("文件已变化、不是普通文件或超出读取上限");
    const buffer = Buffer.alloc(limit + 1), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit || buffer.subarray(0, bytesRead).includes(0)) throw new Error("文件过长或为二进制文件");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally { await file.close(); }
}
export async function listFiles(root: string, signal: AbortSignal, filter = "", limit = 200): Promise<string[]> {
  await registeredRoot(root); const out: string[] = []; let scanned = 0;
  const visit = async (directory: string): Promise<void> => {
    signal.throwIfAborted();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (out.length >= limit) return;
      const path = join(directory, entry.name), rel = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink() || sensitivePath(rel)) continue;
      if (entry.isDirectory()) { if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) await visit(path); }
      else if (entry.isFile()) {
        if (++scanned > 20000) throw new Error("项目文件过多，请缩小查询范围");
        if (rel.toLowerCase().includes(filter.toLowerCase())) out.push(rel);
      }
    }
  };
  await visit(root); return out.sort();
}
export async function readLines(root: string, value: string, start = 1, limit = 200): Promise<View> {
  const lines = (await readText(root, value)).replaceAll("\r\n", "\n").split("\n"), end = Math.min(lines.length, start - 1 + limit);
  return { path: value, start_line: start, lines: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${redact(line, 4096)}`), truncated: end < lines.length };
}
