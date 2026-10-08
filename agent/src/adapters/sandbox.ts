import type { Resource } from "../domain/entities.js";
import { requireCondition, LakeError } from "../domain/errors.js";
import { runProcess } from "./process.js";
import {
  realpath,
  mkdtemp,
  readdir,
  mkdir,
  open,
  chmod,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
export class ContainerSandbox {
  constructor(private readonly secretsRoot?: string) {}
  async runTest(resource: Resource, signal: AbortSignal): Promise<unknown> {
    const p = resource.settings.testProfile as
      | {
          image?: string;
          argv?: string[];
        }
      | undefined;
    requireCondition(
      p?.image &&
        p.argv?.length &&
        p.argv.every((v) => typeof v === "string") &&
        !p.image.startsWith("-"),
      "capability_unavailable",
      "No isolated test profile",
    );
    try {
      const available = await runProcess(
        "docker",
        ["info", "--format", "{{.ServerVersion}}"],
        { signal, timeoutMs: 5000 },
      );
      requireCondition(available.exitCode === 0, "capability_unavailable");
    } catch {
      throw new LakeError(
        "capability_unavailable",
        "Container test environment is unavailable",
      );
    }
    const root = await realpath(resource.endpoint);
    requireCondition(
      !/[,:]/.test(root) &&
        (!this.secretsRoot ||
          (root !== resolve(this.secretsRoot) &&
            !root.startsWith(resolve(this.secretsRoot) + "/"))),
      "scope_denied",
    );
    const staging = await mkdtemp(join(tmpdir(), "lake-sandbox-")),
      workspace = join(staging, "workspace"),
      name = "lake-workspace-" + randomUUID();
    let files = 0,
      bytes = 0;
    const copy = async (source: string, destination: string): Promise<void> => {
      await mkdir(destination, { mode: 0o755 });
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (
          entry.isSymbolicLink() ||
          entry.name.startsWith(".") ||
          /^id_(rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(entry.name) ||
          [".git", ".lake", "secrets", "node_modules"].includes(entry.name) ||
          /^\.env(?:\.|$)/.test(entry.name) ||
          /\.(pem|key)$/.test(entry.name)
        )
          continue;
        const from = join(source, entry.name),
          to = join(destination, entry.name);
        if (entry.isDirectory()) await copy(from, to);
        else if (entry.isFile()) {
          const fd = await open(
            from,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const st = await fd.stat();
            files++;
            bytes += st.size;
            requireCondition(
              st.isFile() && files <= 5000 && bytes <= 268435456,
              "output_limit",
            );
            const target = await open(
              to,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
              st.mode & 0o111 ? 0o755 : 0o644,
            );
            try {
              await target.writeFile(await fd.readFile());
            } finally {
              await target.close();
            }
          } finally {
            await fd.close();
          }
        }
      }
    };
    try {
      await copy(root, workspace);
      return await runProcess(
        "docker",
        [
          "run",
          "--rm",
          "--name",
          name,
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--cpus=1",
          "--memory=512m",
          "--pids-limit=128",
          "--user=65534:65534",
          "--tmpfs=/tmp:rw,nosuid,nodev,size=256m",
          "--mount",
          `type=bind,src=${workspace},dst=/workspace,readonly`,
          "--workdir=/workspace",
          p.image,
          ...p.argv,
        ],
        { signal, timeoutMs: 30000, maxBytes: 65536 },
      );
    } finally {
      await runProcess("docker", ["rm", "-f", name], {
        signal: new AbortController().signal,
        timeoutMs: 5000,
      }).catch(() => {});
      await rm(staging, { recursive: true, force: true });
    }
  }
}
