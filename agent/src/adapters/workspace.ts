import {
  readFile,
  lstat,
  realpath,
  open,
  rename,
  rm,
  readdir,
} from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Resource } from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export interface ArtifactPort {
  put(text: string, sessionId?: string): Promise<string>;
  read(id: string): Promise<string>;
}
export class WorkspaceAdapter {
  constructor(
    private readonly artifacts: ArtifactPort,
    private readonly secretsRoot: string,
  ) {}
  private async path(
    resource: Resource,
    path: string,
    existing = true,
  ): Promise<string> {
    const root = await realpath(resource.endpoint),
      target = resolve(root, path);
    requireCondition(
      target.startsWith(root + "/") &&
        target !== this.secretsRoot &&
        !target.startsWith(resolve(this.secretsRoot) + "/"),
      "scope_denied",
    );
    const parts = relative(root, target).split("/");
    requireCondition(
      !parts.some(
        (p) =>
          [".git", ".lake", "secrets"].includes(p) ||
          /^\.env(?:\.|$)/.test(p) ||
          /\.(pem|key)$/.test(p),
      ),
      "scope_denied",
      "Private path is excluded",
    );
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!);
      try {
        const st = await lstat(current);
        requireCondition(!st.isSymbolicLink(), "scope_denied");
      } catch (e) {
        if (existing || i < parts.length - 1) throw e;
      }
    }
    requireCondition(
      (await realpath(dirname(target))).startsWith(root),
      "scope_denied",
    );
    return target;
  }
  async read(
    resource: Resource,
    path: string,
  ): Promise<{
    content: string;
    hash: string;
  }> {
    const target = await this.path(resource, path);
    const fd = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await fd.stat();
      requireCondition(st.isFile() && st.size <= 65536, "output_limit");
      const content = await fd.readFile("utf8");
      return { content, hash: sha256(content) };
    } finally {
      await fd.close();
    }
  }
  async search(
    resource: Resource,
    path: string,
    query: string,
  ): Promise<unknown[]> {
    const root = await realpath(resource.endpoint),
      start = path === "." ? root : await this.path(resource, path);
    const result: unknown[] = [];
    let visited = 0;
    const visit = async (current: string): Promise<void> => {
      for (const e of await readdir(current, { withFileTypes: true })) {
        if (++visited > 2000 || result.length >= 200) return;
        if (
          e.isSymbolicLink() ||
          e.name.startsWith(".") ||
          ["node_modules", "secrets"].includes(e.name)
        )
          continue;
        const target = join(current, e.name);
        if (e.isDirectory()) await visit(target);
        else
          try {
            const data = await this.read(resource, relative(root, target));
            for (const [i, line] of data.content.split("\n").entries())
              if (line.includes(query))
                result.push({
                  path: relative(root, target),
                  line: i + 1,
                  text: line.slice(0, 300),
                });
          } catch {}
      }
    };
    await visit(start);
    return result;
  }
  async proposePatch(
    resource: Resource,
    path: string,
    expectedHash: string,
    content: string,
    sessionId: string,
  ): Promise<string> {
    requireCondition(
      !content.includes("[REDACTED"),
      "invalid_input",
      "Redacted configuration cannot be applied",
    );
    const old = await this.read(resource, path);
    requireCondition(old.hash === expectedHash, "precondition_failed");
    return this.artifacts.put(
      JSON.stringify({
        kind: "patch",
        resourceId: resource.id,
        path,
        expectedHash,
        content,
      }),
      sessionId,
    );
  }
  async applyPatch(
    resource: Resource,
    path: string,
    expectedHash: string,
    artifactId: string,
  ): Promise<{
    hash: string;
  }> {
    const artifact = JSON.parse(await this.artifacts.read(artifactId));
    requireCondition(
      artifact.kind === "patch" &&
        artifact.resourceId === resource.id &&
        artifact.path === path &&
        artifact.expectedHash === expectedHash &&
        typeof artifact.content === "string",
      "scope_denied",
    );
    requireCondition(
      !artifact.content.includes("[REDACTED"),
      "invalid_input",
      "Redacted configuration cannot be applied",
    );
    const target = await this.path(resource, path),
      old = await this.read(resource, path);
    requireCondition(old.hash === expectedHash, "precondition_failed");
    const stat = await lstat(target),
      temp = target + ".lake-" + randomUUID();
    const fd = await open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      stat.mode & 0o777,
    );
    try {
      await fd.writeFile(artifact.content);
      await fd.sync();
    } finally {
      await fd.close();
    }
    try {
      requireCondition(
        (await this.read(resource, path)).hash === expectedHash,
        "precondition_failed",
      );
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
    return { hash: sha256(artifact.content) };
  }
}
