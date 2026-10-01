import { spawn } from "node:child_process";
import type { LakeRuntime } from "../../domain/protocol.js";
import { object, text, type Params } from "../../domain/validation.js";
import { readModelConfig } from "../config/files.js";
import { FileVault } from "../vault.js";

/** Only the explicitly invoked signed migration can access old macOS Keychain items. */
export async function legacyPipe(launcher: string, action: string, id: string): Promise<Buffer> {
  const child = spawn(launcher, ["__legacy_keychain", action, id], {
    stdio: ["ignore", "ignore", "ignore", "pipe"],
    env: { ...process.env, LAKE_EXPLICIT_SECRET_MIGRATION: "1" },
  });
  const pipe = child.stdio[3];
  if (!pipe || !("on" in pipe)) throw new Error("迁移凭据通道不可用");
  const chunks: Buffer[] = [];
  let size = 0,
    overflow = false;
  pipe.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > 1024 * 1024) {
      chunk.fill(0);
      overflow = true;
      child.kill();
    } else chunks.push(chunk);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new Error("无法启动签名迁移入口")));
      child.once("close", (code) =>
        code === 0 && !overflow ? resolve() : reject(new Error("旧凭据未迁移；请检查钥匙串授权")),
      );
    });
    return Buffer.concat(chunks);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

export async function migrateSecrets(root: string, runtime: LakeRuntime): Promise<Params> {
  const launcher = process.env.LAKE_SIGNED_LAUNCHER;
  if (process.env.LAKE_EXPLICIT_SECRET_MIGRATION !== "1" || !launcher)
    throw new Error("请使用签名的 bin/lake secrets migrate 执行一次性迁移");
  const vault = new FileVault(root),
    config = await readModelConfig(root),
    migrated: string[] = [],
    failed: string[] = [];
  for (const provider of Object.keys(object(config.model_providers))) {
    if (await vault.has("model", provider)) continue;
    let bytes: Buffer | undefined;
    try {
      bytes = await legacyPipe(launcher, "load-model", provider);
      await vault.put("model", provider, bytes);
      await legacyPipe(launcher, "delete-model", provider);
      migrated.push(`model:${provider}`);
    } catch {
      failed.push(`model:${provider}`);
    } finally {
      bytes?.fill(0);
    }
  }
  const resources = (await runtime.dispatch({ method: "res.list", params: {} })) as Params[];
  for (const resource of resources) {
    const ref = text(
      object(
        await runtime.dispatch({
          method: "res.credential",
          params: { resource: resource.id, optional: true },
        }),
      ),
      "ref",
    );
    if (!ref.startsWith("keychain:")) continue;
    let bytes: Buffer | undefined,
      imported = "",
      committed = false;
    try {
      bytes = await legacyPipe(launcher, "load-ssh", ref);
      imported = await vault.import("ssh", bytes);
      await runtime.dispatch({
        method: "res.set_credential",
        params: { resource: resource.id, credential_ref: imported },
      });
      committed = true;
      await legacyPipe(launcher, "delete-ssh", ref);
      migrated.push(`resource:${resource.id}`);
    } catch {
      if (imported && !committed) await vault.deleteReference(imported);
      failed.push(`resource:${resource.id}`);
    } finally {
      bytes?.fill(0);
    }
  }
  return { migrated, failed };
}
