import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import "./check-runtime.mjs";
async function collect(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...(await collect(p)));
    else if (!e.name.startsWith("._") && p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}
export async function runSuite(suite) {
  if (!["unit", "integration", "acceptance"].includes(suite))
    throw new Error("Unknown suite");
  const paths = await collect(resolve(import.meta.dirname, "../test", suite));
  if (!paths.length) throw new Error("No tests in required suite");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--test", "--test-concurrency=1", ...paths],
    { stdio: "inherit", cwd: resolve(import.meta.dirname, "..") },
  );
  await new Promise((r) =>
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
      r();
    }),
  );
}
await runSuite(process.argv[2]);
