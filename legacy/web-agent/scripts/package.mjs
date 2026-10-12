import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir, rename, rm, readlink, realpath } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dirname, ".."), repo = resolve(root, "..");
if (!/^24\./.test(process.versions.node)) throw Error("Lake Web runtime requires Node 24");
async function run(file, args, cwd = root) { await new Promise((yes, no) => { const child = spawn(file, args, { cwd, stdio: "inherit" }); child.on("error", no); child.on("exit", code => code === 0 ? yes() : no(Error("Web release build failed"))); }); }
function canonical(value) { if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"; if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}"; return JSON.stringify(value); }
async function walk(dir) { const files = []; for (const entry of await readdir(dir, { withFileTypes: true })) { const p = join(dir, entry.name); if (entry.isDirectory()) files.push(...await walk(p)); else files.push(p); } return files; }
await run("pnpm", ["build"]);
const releases = join(repo, "bin/lake-web-runtime/releases"); await mkdir(releases, { recursive: true }); const staging = await mkdtemp(join(releases, ".staging-"));
try {
  const stage = join(staging, "runtime");
  await run("pnpm", ["--filter", "lake-web-agent", "deploy", "--legacy", "--prod", stage]);
  await cp(process.execPath, join(stage, "node"));
  if (process.platform === "darwin") for (const file of [join(stage, "node"), ...(await walk(stage)).filter(p => p.endsWith(".node"))]) { await run("codesign", ["--force", "--timestamp=none", "--sign", "Lake Local Development Code Signing", file]); await run("codesign", ["--verify", "--strict", file]); }
  const files = {}, links = {};
  for (const file of await walk(stage)) { const name = relative(stage, file).replaceAll("\\", "/"); try { const target = await readlink(file); if (!(await realpath(file)).startsWith((await realpath(stage)) + "/")) throw Error("Release link escapes runtime"); links[name] = target; } catch (error) { if (error.code !== "EINVAL") throw error; if (name !== "manifest.json") files[name] = createHash("sha256").update(await readFile(file)).digest("hex"); } }
  const body = { schemaVersion: 1, version: "0.1.0", nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, files, links };
  const digest = createHash("sha256").update(canonical(body)).digest("hex"); await writeFile(join(stage, "manifest.json"), JSON.stringify({ ...body, digest }, null, 2) + "\n");
  const output = join(releases, "0.1.0-" + digest); try { await rename(stage, output); } catch (error) { if (["EEXIST", "ENOTEMPTY"].includes(error.code)) await rm(stage, { recursive: true, force: true }); else throw error; }
  await writeFile(join(root, "dist/release.json"), JSON.stringify({ path: relative(join(repo, "bin"), output).replaceAll("\\", "/"), digest }));
  console.log("Go AI Web runtime ready: " + relative(repo, output));
} finally { await rm(staging, { recursive: true, force: true }); }
