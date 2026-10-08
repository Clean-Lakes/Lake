import { readdir, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
const root = resolve(import.meta.dirname, "../src");
async function files(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}
export async function checkImports() {
  for (const path of await files(root)) {
    const text = await readFile(path, "utf8");
    const layer = relative(root, path).split("/")[0];
    for (const match of text.matchAll(
      /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g,
    )) {
      const spec = match[1];
      if (/zcode|tianshu|langgraph/i.test(spec))
        throw new Error(`Legacy runtime import: ${relative(root, path)}`);
      if (
        layer === "domain" &&
        (/^(node:|fs$|ssh2$|pg$|fs-ext$)/.test(spec) || spec.startsWith("../"))
      )
        throw new Error(`Domain IO import: ${relative(root, path)}`);
      if (
        [
          "agent",
          "specialists",
          "sessions",
          "operations",
          "runner",
          "verification",
        ].includes(layer) &&
        /^\.\.\/(adapters|storage|app|surfaces)\//.test(spec)
      )
        throw new Error(`Boundary violation: ${relative(root, path)}`);
    }
  }
  console.log("Module boundaries passed");
}
await checkImports();
