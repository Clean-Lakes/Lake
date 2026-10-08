import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rename,
  rm,
  readlink,
  realpath,
} from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import "./check-runtime.mjs";
const root = resolve(import.meta.dirname, ".."),
  repo = resolve(root, "..");
async function run(file, args, cwd = root) {
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Build step failed")),
    );
  });
}
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}
export async function buildRuntime(packageRuntime = true) {
  await run("pnpm", ["exec", "tsc"]);
  await cp(
    join(root, "src/storage/migrations"),
    join(root, "dist/storage/migrations"),
    { recursive: true },
  );
  if (!process.argv.includes("--reuse-ui"))
    await run("pnpm", ["--dir", "ui", "build"]);
  if (!packageRuntime) return;
  const releases = join(repo, "bin/lake-agent-runtime/releases");
  await mkdir(releases, { recursive: true });
  const staging = await mkdtemp(join(releases, ".staging-"));
  try {
    const stage = join(staging, "runtime");
    await run("pnpm", [
      "--filter",
      "lake-agent",
      "deploy",
      "--legacy",
      "--prod",
      stage,
    ]);
    await cp(process.execPath, join(stage, "node"));
    if (process.platform === "darwin") {
      const identity = "Lake Local Development Code Signing";
      for (const file of [
        join(stage, "node"),
        ...(await walk(stage)).filter((p) => p.endsWith(".node")),
      ]) {
        await run("codesign", [
          "--force",
          "--timestamp=none",
          "--sign",
          identity,
          file,
        ]);
        await run("codesign", ["--verify", "--strict", file]);
      }
    }
    const files = {},
      links = {};
    for (const file of await walk(stage)) {
      const name = relative(stage, file).replaceAll("\\", "/");
      try {
        const target = await readlink(file);
        if (!(await realpath(file)).startsWith((await realpath(stage)) + "/"))
          throw new Error("Release symlink escapes runtime");
        links[name] = target;
      } catch (error) {
        if (error.code !== "EINVAL") throw error;
        if (name !== "manifest.json")
          files[name] = createHash("sha256")
            .update(await readFile(file))
            .digest("hex");
      }
    }
    const body = {
      schemaVersion: 1,
      version: "0.0.1",
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      files,
      links,
    };
    const digest = createHash("sha256").update(canonical(body)).digest("hex");
    await writeFile(
      join(stage, "manifest.json"),
      JSON.stringify({ ...body, digest }, null, 2) + "\n",
    );
    const name = "0.0.1-" + digest;
    const output = join(releases, name);
    try {
      await rename(stage, output);
    } catch (error) {
      if (error.code === "EEXIST" || error.code === "ENOTEMPTY")
        await rm(stage, { recursive: true, force: true });
      else throw error;
    }
    await writeFile(
      join(root, "dist/release.json"),
      JSON.stringify({
        path: relative(join(repo, "bin"), output).replaceAll("\\", "/"),
        digest,
        platform: process.platform,
        arch: process.arch,
      }),
    );
    console.log("Lake runtime ready: " + relative(repo, output));
    return output;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
await buildRuntime(!process.argv.includes("--compile-only"));
