import {
  readFile,
  mkdtemp,
  cp,
  rm,
  lstat,
  readlink,
  realpath,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import "./check-runtime.mjs";
const root = resolve(import.meta.dirname, ".."),
  repo = resolve(root, "..");
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
async function command(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Independent release command failed")),
    );
  });
}
export async function verifyRelease(path) {
  const manifest = JSON.parse(
      await readFile(join(path, "manifest.json"), "utf8"),
    ),
    { digest, ...body } = manifest;
  if (createHash("sha256").update(canonical(body)).digest("hex") !== digest)
    throw new Error("Manifest digest mismatch");
  if (manifest.platform !== process.platform || manifest.arch !== process.arch)
    throw new Error("Wrong release target");
  for (const [name, hash] of Object.entries(manifest.files)) {
    const file = resolve(path, name);
    if (!file.startsWith(resolve(path) + "/"))
      throw new Error("Manifest path escapes release");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Unexpected release file");
    if (
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex") !== hash
    )
      throw new Error("Release hash mismatch");
  }
  for (const [name, target] of Object.entries(manifest.links ?? {})) {
    const file = resolve(path, name);
    if (!file.startsWith(resolve(path) + "/"))
      throw new Error("Release link path escapes");
    if (
      (await readlink(file)) !== target ||
      !(await realpath(file)).startsWith((await realpath(path)) + "/")
    )
      throw new Error("Release symlink mismatch");
  }
  const temp = await mkdtemp(join(tmpdir(), "lake-independent-"));
  try {
    const independent = join(temp, "runtime");
    await cp(path, independent, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    await command(
      join(independent, "node"),
      [join(independent, "dist/surfaces/cli.js"), "version"],
      temp,
    );
    await command(
      join(independent, "node"),
      [
        "--input-type=module",
        "-e",
        "import('fs-ext').then(()=>import('node:sqlite'))",
      ],
      independent,
    );
    await readFile(join(independent, "builtin/skills/sre-diagnosis/SKILL.md"));
    const home = join(temp, "private-home");
    await mkdir(join(home, "agent"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, "agent/config.json"),
      JSON.stringify({
        schemaVersion: 1,
        defaultProvider: "fixture",
        providers: [
          {
            id: "fixture",
            baseUrl: "http://127.0.0.1:1/v1",
            model: "fixture",
            contextWindowTokens: 32768,
            maxOutputTokens: 1024,
            supportsTools: true,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const daemon = spawn(
      join(independent, "node"),
      [join(independent, "dist/surfaces/cli.js"), "serve", "--home", home],
      {
        cwd: temp,
        env: { ...process.env, PATH: "/usr/bin:/bin", LAKE_ZCODE_DIR: "" },
        stdio: "ignore",
      },
    );
    const ended = new Promise((r) => daemon.on("exit", r));
    try {
      let info;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          info = JSON.parse(
            await readFile(join(home, "agent/runtime/daemon.json"), "utf8"),
          );
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (!info) throw new Error("Independent daemon did not start");
      const api = await fetch(info.origin + "/api/v1/resources", {
        headers: { Authorization: "Bearer " + info.token },
      });
      if (!api.ok) throw new Error("Independent API failed");
      const ui = await fetch(info.origin + "/");
      if (!ui.ok || !(await ui.text()).includes('id="root"'))
        throw new Error("Independent UI failed");
    } finally {
      daemon.kill("SIGTERM");
      await ended;
    }
    console.log(
      "Independent runtime, builtin and native-module verification passed",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
const release =
  process.argv[2] ??
  JSON.parse(await readFile(join(root, "dist/release.json"), "utf8")).path;
await verifyRelease(resolve(join(repo, "bin"), release));
