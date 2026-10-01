import { remoteRoot, text, type Params } from "./validation.js";
import { shellQuote as q, terminalCommand, workspaceRelative } from "./workspace.js";

export function remotePrefix(root: string): string {
  remoteRoot(root); return `set -eu; cd -- ${q(root)}; [ "$(pwd -P)" = ${q(root)} ] || exit 74; `;
}
export function remotePlan(method: string, p: Params): { command: string; input?: string } {
  const root = text(p, "root"), prefix = remotePrefix(root);
  if (method === "remote.probe") return { command: "sh -c " + q(prefix + "pwd -P") };
  if (method === "remote.files") return { command: "sh -c " + q(prefix + "find . -type f -print0") };
  if (method === "remote.run") return { command: "sh -c " + q(prefix + "sh -c " + q(terminalCommand(text(p, "command")))) };
  const relative = workspaceRelative(text(p, "path")), parts = relative.split("/");
  // Reject every path component which is a symlink before resolving its parent.
  let checked = "", guard = "";
  for (const part of parts) { checked = checked ? checked + "/" + part : part; guard += `[ ! -L ${q(checked)} ] || exit 76; `; }
  const target = `target=${q(relative)}; `;
  if (method === "remote.read") return { command: "sh -c " + q(prefix + guard + target + '[ -f "$target" ] || exit 76; head -c 65537 -- "$target"') };
  if (method !== "remote.write") throw new Error("未知的远程文件操作");
  const expected = text(p, "expected_sha256"), content = text(p, "content");
  if (expected !== "absent" && !/^[a-f0-9]{64}$/u.test(expected)) throw new Error("原文件 SHA-256 无效");
  if (content.length > 65536 || content.includes("\0")) throw new Error("远程文件内容超过限制或含二进制数据");
  const compare = expected === "absent" ? '[ ! -e "$target" ] || exit 77; ' : `[ -f "$target" ] && [ "$(sha256sum -- "$target" | cut -d ' ' -f 1)" = ${q(expected)} ] || exit 77; `;
  const script = prefix + guard + target + compare + 'parent=$(dirname -- "$target"); tmp=$(mktemp "$parent/.lake-write.XXXXXX"); trap \'rm -f "$tmp"\' EXIT; cat > "$tmp"; chmod 600 "$tmp"; ' + guard + compare + (expected === "absent" ? 'ln -- "$tmp" "$target"; ' : 'mv -f -- "$tmp" "$target"; ') + 'sha256sum -- "$target" | cut -d \' \' -f 1';
  return { command: "sh -c " + q(script), input: content };
}
