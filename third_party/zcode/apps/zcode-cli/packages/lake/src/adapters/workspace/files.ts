import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sensitivePath, workspaceRelative } from "../../domain/workspace.js";

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
