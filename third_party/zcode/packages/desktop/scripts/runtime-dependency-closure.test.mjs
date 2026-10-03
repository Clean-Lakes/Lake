import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectRuntimeModuleClosureEntries } from "./runtime-dependency-closure.mjs";

test("dependency closure keeps the real package root above nested module-type manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "lake-package-root-"));
  try {
    const parent = join(root, "node_modules/fixture-parent");
    const dependency = join(parent, "node_modules/fixture-dependency");
    await mkdir(join(dependency, "dist/cjs"), { recursive: true });
    await writeFile(join(parent, "package.json"), JSON.stringify({ name: "fixture-parent", main: "index.cjs", dependencies: { "fixture-dependency": "1.0.0" } }));
    await writeFile(join(parent, "index.cjs"), "module.exports = {};");
    await writeFile(join(dependency, "package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0", main: "dist/cjs/index.cjs", dependencies: { "fixture-leaf": "1.0.0" } }));
    await writeFile(join(dependency, "dist/cjs/package.json"), '{"type":"commonjs"}');
    await writeFile(join(dependency, "dist/cjs/index.cjs"), "exports.value = 1;");
    await mkdir(join(dependency, "node_modules/fixture-leaf"), { recursive: true });
    await writeFile(join(dependency, "node_modules/fixture-leaf/package.json"), JSON.stringify({ name: "fixture-leaf", main: "index.cjs" }));
    await writeFile(join(dependency, "node_modules/fixture-leaf/index.cjs"), "module.exports = {};");
    const entries = collectRuntimeModuleClosureEntries(["fixture-parent"], [root]);
    assert.equal(entries.find(entry => entry.moduleName === "fixture-dependency")?.sourceModulePath, await realpath(dependency));
    assert.ok(entries.some(entry => entry.moduleName === "fixture-leaf"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
