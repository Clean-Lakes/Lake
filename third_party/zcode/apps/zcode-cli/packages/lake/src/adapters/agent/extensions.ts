import { dirname, join } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createConfig } from "@zcode/adapters/config";
import { object, text, type Params } from "../../domain/validation.js";
import { atomicFile, readSettings } from "../config/files.js";
import type { FileVault } from "../vault.js";

export function nativeEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LAKE_HOME: join(root, "zcode-runtime", "storage"),
    ZCODE_STORAGE_DIR: join(root, "zcode-runtime", "storage"),
    ZCODE_DATA_BASE_DIR: join(root, "zcode-runtime"),
  };
}
export function nativeExtensionSignature(workspace: string, root: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        createConfig({ workingDirectory: workspace || process.cwd(), env: nativeEnvironment(root) })
          .config,
      ),
    )
    .digest("hex");
}

/** Translate saved connection/profile DTOs; loading, tools, permissions and execution remain native. */
export async function prepareNativeExtensions(
  root: string,
  directory: string,
  vault: FileVault,
  workspace: string,
): Promise<{ mcp: Params[]; signature: string }> {
  const settings = await readSettings(root),
    native = createConfig({ workingDirectory: workspace, env: nativeEnvironment(root) }).config;
  const servers: Params[] = [];
  const configured = new Map<string, Params>(
    Object.entries(native.mcp.servers).map(([name, value]) => [
      name,
      { ...object(value as unknown as Params), name },
    ]),
  );
  for (const item of (Array.isArray(settings.mcp) ? settings.mcp : []).map(object))
    if (item.name) configured.set(text(item, "name"), item);
  for (const server of configured.values()) {
    if (server.enabled === false || server.disabled === true || server.name === "lake") continue;
    let secrets: Params = {};
    if (server.secret_ref) {
      const bytes = await vault.load("mcp", text(server, "secret_ref"));
      try {
        secrets = object(JSON.parse(bytes.toString()));
      } finally {
        bytes.fill(0);
      }
    }
    const entries = (values: Params) =>
      Object.entries(values).map(([name, value]) => ({ name, value: String(value) }));
    const common = { name: server.name!, protocolVersion: "legacy", timeoutMs: 300_000 };
    if (server.command)
      servers.push({
        ...common,
        command: server.command,
        args: server.args ?? [],
        env: entries({ ...object(server.env), ...object(secrets.env) }),
      });
    else if (server.url)
      servers.push({
        ...common,
        type: server.type === "sse" ? "sse" : "http",
        url: server.url,
        headers: entries({ ...object(server.headers), ...object(secrets.headers) }),
      });
  }
  const storage = join(dirname(directory), "storage");
  const index = join(storage, "lake-managed-agents.json"),
    names: string[] = [];
  let previous: string[] = [];
  try {
    previous = JSON.parse(await readFile(index, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const profile of (Array.isArray(settings.specialists) ? settings.specialists : []).map(
    object,
  )) {
    if (profile.enabled === false) continue;
    const name = text(profile, "name");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("旧专员名称无法迁入原生 Agent");
    names.push(name);
    await atomicFile(
      join(storage, "agents", "lake-" + name + ".md"),
      `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(text(profile, "description"))}\n---\n${text(profile, "instruction")}\n`,
    );
  }
  for (const name of previous)
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(name) && !names.includes(name))
      await unlink(join(storage, "agents", "lake-" + name + ".md")).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  await atomicFile(index, JSON.stringify(names));
  return { mcp: servers, signature: JSON.stringify([settings, native]) };
}
