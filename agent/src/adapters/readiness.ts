import { readFile, access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, delimiter } from "node:path";
import { createHash } from "node:crypto";
import { runProcess } from "./process.js";
export async function runtimeReadiness(): Promise<unknown> {
  const check = async (name: string, args: string[]) => {
    let path: string | undefined;
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      if (!directory) continue;
      try {
        const candidate = join(directory, name);
        await access(candidate, constants.X_OK);
        path = await realpath(candidate);
        break;
      } catch {}
    }
    if (!path) return { available: false, reason: "executable_missing" };
    const digest = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    try {
      const result = await runProcess(path, args, {
        signal: new AbortController().signal,
        timeoutMs: 5000,
        maxBytes: 65536,
      });
      return {
        available: result.exitCode === 0,
        path,
        sha256: digest,
        version: result.exitCode === 0 ? result.stdout.trim() : null,
        reason: result.exitCode === 0 ? null : "endpoint_unavailable",
      };
    } catch {
      return { available: false, path, sha256: digest, reason: "probe_failed" };
    }
  };
  const [kubectl, docker] = await Promise.all([
    check("kubectl", ["version", "--client", "-o", "json"]),
    check("docker", ["info", "--format", "{{.ServerVersion}}"]),
  ]);
  return {
    kubectl,
    docker,
    ssh: { available: true, targets: "linux-posix" },
    postgres: { available: true, access: "fixed-read-only" },
    externalProviderSmoke: "not_run",
  };
}
