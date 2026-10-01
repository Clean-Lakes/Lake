import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { View } from "../../domain/validation.js";
import { redact } from "../../domain/validation.js";
import { MAX_GIT_BYTES, sensitivePath, workspaceRelative } from "../../domain/workspace.js";
import { readText, registeredRoot } from "./files.js";

const execute = promisify(execFile);
async function git(root: string, args: string[], signal: AbortSignal): Promise<string> {
  await registeredRoot(root);
  const { stdout } = await execute("git", ["-C", root, "--no-pager", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", ...args], {
    signal, timeout: 10000, maxBuffer: MAX_GIT_BYTES, encoding: "utf8",
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" },
  });
  return stdout;
}
export async function gitOverview(root: string, signal: AbortSignal): Promise<View> {
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", "."], signal), files: View[] = [], entries = status.split("\0");
  for (let i = 0; i < entries.length && files.length < 200; i++) {
    const entry = entries[i]; if (!entry || entry.length < 4 || entry[2] !== " ") continue;
    const code = entry.slice(0, 2), path = entry.slice(3);
    if (/[RC]/u.test(code)) i++;
    if (!sensitivePath(path)) files.push({ path, status: code });
  }
  let branch = "(detached)", log = "", graph = "";
  try { branch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal)).trim(); } catch (error) { signal.throwIfAborted(); if (Number((error as { code?: number }).code) !== 1) throw error; }
  try { log = await git(root, ["log", "-20", "-z", "--format=%H%x00%h%x00%s%x00%an%x00%aI%x00", "--", "."], signal); }
  catch (error) { signal.throwIfAborted(); if (Number((error as { code?: number }).code) !== 128) throw error; }
  const fields = log.split("\0"), commits: View[] = [];
  for (let i = 0; i + 4 < fields.length && commits.length < 20;) {
    const hash = fields[i]?.trim(); if (!hash) { i++; continue; }
    commits.push({ hash, short: fields[i + 1] ?? "", subject: redact(fields[i + 2] ?? ""), author: fields[i + 3] ?? "", date: fields[i + 4] ?? "" }); i += 5;
  }
  if (commits.length) graph = redact(await git(root, ["log", "--graph", "--all", "--oneline", "--decorate=short", "--no-color", "-20", "--", "."], signal), MAX_GIT_BYTES);
  return { branch, files, commits, graph };
}
export async function gitDiff(root: string, path: string, signal: AbortSignal): Promise<string> {
  workspaceRelative(path);
  const base = ["--literal-pathspecs", "diff"], common = ["--no-ext-diff", "--no-textconv", "--no-renames", "--", path];
  const content = await git(root, [...base, ...common], signal) + await git(root, [...base, "--cached", ...common], signal);
  if (Buffer.byteLength(content) > MAX_GIT_BYTES) throw new Error("Git 差异超过 64 KiB");
  if (content) return redact(content, MAX_GIT_BYTES);
  try { await git(root, ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", path], signal); return ""; }
  catch (error) { signal.throwIfAborted(); if (Number((error as { code?: number }).code) !== 1) throw error; }
  const text = await readText(root, path, MAX_GIT_BYTES / 2);
  return redact(`diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n` + text.split("\n").map(line => "+" + line).join("\n"), MAX_GIT_BYTES);
}
