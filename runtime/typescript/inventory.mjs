import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "third_party/agent-sdk/package.json"));
const ts = require("typescript");
const input = await readFile(join(root, "web-agent/web/src/api.ts"), "utf8");
const file = ts.createSourceFile("api.ts", input, ts.ScriptTarget.Latest, true);
const operations = [];
function visit(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(file) === "api" &&
    node.initializer &&
    ts.isObjectLiteralExpression(node.initializer)
  ) {
    for (const property of node.initializer.properties) {
      if (!property.name) continue;
      const name = property.name.getText(file);
      const routes = [];
      function route(child) {
        if (
          ts.isCallExpression(child) &&
          ["request", "post"].includes(child.expression.getText(file)) &&
          child.arguments[0]
        ) {
          let method = child.expression.getText(file) === "post" ? "POST" : "GET";
          const init = child.arguments[1];
          if (init && ts.isObjectLiteralExpression(init)) {
            const field = init.properties.find((field) => field.name?.getText(file) === "method");
            if (field?.initializer)
              method = ts.isStringLiteral(field.initializer)
                ? field.initializer.text
                : field.initializer.getText(file);
          }
          routes.push({ method, path: child.arguments[0].getText(file) });
        }
        ts.forEachChild(child, route);
      }
      route(property);
      if (name === "eventsUrl")
        routes.push({ method: "GET", path: "`/api/sessions/${sessionId}/events?after=${cursor}`" });
      operations.push({ name, routes });
    }
  }
  ts.forEachChild(node, visit);
}
visit(file);
operations.sort((a, b) => a.name.localeCompare(b.name, "en"));
const result =
  JSON.stringify(
    {
      schemaVersion: 1,
      source: "web-agent/web/src/api.ts",
    baselineCommit: "16ef70750bf63a9fc6b800ce6cac674c7194257e",
      operations,
    },
    null,
    2,
  ) + "\n";
const output = join(root, "runtime/typescript/api-inventory.json");
if (process.argv.includes("--write")) {
  await writeFile(output, result);
  console.log(`Recorded ${operations.length} Lake UI operations`);
} else if ((await readFile(output, "utf8")) !== result) {
  throw new Error("Lake API inventory is stale; regenerate and review the parity matrix");
} else console.log(`Lake UI inventory: ${operations.length} operations match current source`);
