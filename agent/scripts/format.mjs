import ts from "typescript";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
async function format(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, e.name);
    if (e.isDirectory()) await format(path);
    else if (/\.tsx?$/.test(path)) {
      const source = ts.createSourceFile(
        path,
        await readFile(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      await writeFile(
        path,
        ts
          .createPrinter({ newLine: ts.NewLineKind.LineFeed })
          .printFile(source),
      );
    }
  }
}
for (const folder of ["src", "ui/src", "test"])
  await format(resolve(import.meta.dirname, "..", folder));
