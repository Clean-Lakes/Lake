import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { requireCondition } from "../domain/errors.js";
export async function readSkillCatalog(root: string): Promise<
  {
    text: string;
    source: string;
  }[]
> {
  const stat = await lstat(root);
  requireCondition(
    stat.isDirectory() && !stat.isSymbolicLink(),
    "scope_denied",
  );
  const real = await realpath(root);
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "SKILL.md");
    const st = await lstat(path);
    requireCondition(
      st.isFile() && !st.isSymbolicLink() && st.size <= 65536,
      "scope_denied",
    );
    requireCondition(
      (await realpath(path)).startsWith(real + "/"),
      "scope_denied",
    );
    result.push({ text: await readFile(path, "utf8"), source: resolve(path) });
  }
  return result;
}
