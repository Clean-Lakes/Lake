import ssh2 from "ssh2";
import { StringDecoder } from "node:string_decoder";
import type { Client, SFTPWrapper, ClientChannel } from "ssh2";
import type { Resource, ToolResult } from "../domain/entities.js";
import { toolResult } from "../domain/entities.js";
import type { CredentialPort } from "../domain/ports.js";
import { requireCondition, LakeError } from "../domain/errors.js";
import { ConnectionPool } from "../sessions/connection-pool.js";
import { allowedUnit, quoteArgv, configBinding } from "./ssh-templates.js";
import { sha256, type ArtifactPort } from "./workspace.js";
export class SshAdapter {
  private readonly pool = new ConnectionPool<Client>();
  constructor(
    private readonly credentials: CredentialPort,
    private readonly artifacts: ArtifactPort,
  ) {}
  async connect(resource: Resource): Promise<Client> {
    requireCondition(resource.credentialRef, "scope_denied");
    const endpoint = new URL(resource.endpoint);
    requireCondition(
      endpoint.protocol === "ssh:" && !endpoint.username && !endpoint.password,
      "invalid_input",
    );
    const username = resource.settings.username;
    requireCondition(
      typeof username === "string" &&
        username.length > 0 &&
        resource.identity.startsWith("SHA256:"),
      "invalid_input",
    );
    const key = resource.id + ":" + resource.revision + ":" + resource.identity;
    return this.pool.get(key, async () => {
      const privateKey = Buffer.from(
        await this.credentials.resolve(resource.credentialRef!),
      );
      const client = new ssh2.Client();
      try {
        await new Promise<void>((resolve, reject) => {
          const fail = () =>
            reject(
              new LakeError(
                "identity_mismatch",
                "SSH connection or host verification failed",
              ),
            );
          client.once("ready", resolve);
          client.on("error", fail);
          client.once("close", () => this.pool.invalidate(key));
          client.connect({
            host: endpoint.hostname,
            port: Number(endpoint.port || 22),
            username,
            privateKey,
            hostHash: "sha256",
            hostVerifier: (hash: string) =>
              "SHA256:" +
                Buffer.from(hash, "hex")
                  .toString("base64")
                  .replace(/=+$/, "") ===
              resource.identity,
            readyTimeout: 10000,
            keepaliveInterval: 10000,
            keepaliveCountMax: 2,
          });
        });
        return client;
      } catch (e) {
        client.end();
        throw e;
      } finally {
        privateKey.fill(0);
      }
    });
  }
  async executeManaged(
    resource: Resource,
    argv: string[],
    signal: AbortSignal,
    mutating = false,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    const client = await this.connect(resource);
    requireCondition(!signal.aborted, "cancelled");
    return new Promise((resolve, reject) => {
      let settled = false,
        channel: ClientChannel | undefined;
      const timer = setTimeout(
        () => finish(new LakeError(mutating ? "unknown_effect" : "timeout")),
        mutating ? 120000 : 30000,
      );
      const abort = () =>
        finish(new LakeError(mutating ? "unknown_effect" : "cancelled"));
      const finish = (
        error?: LakeError,
        result?: {
          stdout: string;
          stderr: string;
          exitCode: number;
        },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        channel?.close();
        error ? reject(error) : resolve(result!);
      };
      signal.addEventListener("abort", abort, { once: true });
      client.exec(quoteArgv(argv), (error, stream) => {
        if (error) {
          finish(
            new LakeError(
              mutating ? "unknown_effect" : "capability_unavailable",
            ),
          );
          return;
        }
        channel = stream;
        const outDecoder = new StringDecoder("utf8"),
          errDecoder = new StringDecoder("utf8");
        let stdout = "",
          stderr = "",
          bytes = 0;
        stream.on("data", (b: Buffer) => {
          bytes += b.length;
          if (bytes > 65536) {
            finish(new LakeError("output_limit"));
            return;
          }
          stdout += outDecoder.write(b);
        });
        stream.stderr.on("data", (b: Buffer) => {
          bytes += b.length;
          if (bytes > 65536) {
            finish(new LakeError("output_limit"));
            return;
          }
          stderr += errDecoder.write(b);
        });
        stream.on("error", () =>
          finish(
            new LakeError(
              mutating ? "unknown_effect" : "capability_unavailable",
            ),
          ),
        );
        stream.on("close", (code: number | null) => {
          if (code === null || code === undefined)
            finish(
              new LakeError(
                mutating ? "unknown_effect" : "capability_unavailable",
              ),
            );
          else
            finish(undefined, {
              stdout: stdout + outDecoder.end(),
              stderr: stderr + errDecoder.end(),
              exitCode: code,
            });
        });
      });
    });
  }
  async openInteractive(
    resource: Resource,
    onOutput: (chunk: Buffer) => void,
  ): Promise<{
    write(text: string): void;
    close(): void;
  }> {
    const client = await this.connect(resource);
    return new Promise((resolve, reject) =>
      client.shell(
        { term: "xterm-256color", cols: 120, rows: 30 },
        (error, stream) => {
          if (error) {
            reject(new LakeError("capability_unavailable"));
            return;
          }
          stream.on("data", onOutput);
          stream.stderr.on("data", onOutput);
          resolve({
            write(text) {
              stream.write(text);
            },
            close() {
              stream.close();
            },
          });
        },
      ),
    );
  }
  private async sftp(resource: Resource): Promise<SFTPWrapper> {
    const client = await this.connect(resource);
    return new Promise((resolve, reject) =>
      client.sftp((error, sftp) =>
        error ? reject(new LakeError("capability_unavailable")) : resolve(sftp),
      ),
    );
  }
  private async rawConfig(
    resource: Resource,
    path: string,
  ): Promise<{
    data: Buffer;
    mode: number;
    uid: number;
    gid: number;
    hash: string;
  }> {
    configBinding(resource, path);
    const sftp = await this.sftp(resource);
    try {
      const real = await new Promise<string>((resolve, reject) =>
        sftp.realpath(path, (e, p) =>
          e ? reject(new LakeError("capability_unavailable")) : resolve(p),
        ),
      );
      requireCondition(
        real === path,
        "scope_denied",
        "Configuration symlinks are not allowed",
      );
      const stat = await new Promise<any>((resolve, reject) =>
        sftp.lstat(path, (e, s) =>
          e ? reject(new LakeError("capability_unavailable")) : resolve(s),
        ),
      );
      requireCondition(stat.isFile() && stat.size <= 262144, "output_limit");
      const chunks: Buffer[] = [];
      const data = await new Promise<Buffer>((resolve, reject) => {
        const stream = sftp.createReadStream(path);
        let size = 0;
        stream.on("data", (chunk: Buffer | string) => {
          const b = Buffer.from(chunk);
          size += b.length;
          if (size > 262144) {
            stream.destroy();
            reject(new LakeError("output_limit"));
          } else chunks.push(b);
        });
        stream.on("error", () =>
          reject(new LakeError("capability_unavailable")),
        );
        stream.on("end", () => resolve(Buffer.concat(chunks)));
      });
      return {
        data,
        mode: stat.mode & 0o777,
        uid: stat.uid,
        gid: stat.gid,
        hash: sha256(data),
      };
    } finally {
      sftp.end();
    }
  }
  async readConfig(
    resource: Resource,
    path: string,
  ): Promise<{
    content: string;
    hash: string;
  }> {
    const data = await this.rawConfig(resource, path);
    return { content: data.data.toString(), hash: data.hash };
  }
  async prepareReplacement(
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
    const old = await this.rawConfig(resource, path);
    requireCondition(old.hash === expectedHash, "precondition_failed");
    return this.artifacts.put(
      JSON.stringify({
        kind: "ssh-config",
        resourceId: resource.id,
        path,
        expectedHash,
        content,
      }),
      sessionId,
    );
  }
  async replaceConfig(
    resource: Resource,
    path: string,
    expectedHash: string,
    artifactId: string,
    actionId: string,
    signal: AbortSignal,
  ): Promise<{
    oldHash: string;
    newHash: string;
    backupPath: string;
    unit: string;
  }> {
    const binding = configBinding(resource, path),
      artifact = JSON.parse(await this.artifacts.read(artifactId));
    requireCondition(
      artifact.kind === "ssh-config" &&
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
    const old = await this.rawConfig(resource, path);
    requireCondition(old.hash === expectedHash, "precondition_failed");
    const sftp = await this.sftp(resource),
      backupPath = path + ".lake-backup-" + actionId,
      tempPath = path + ".lake-new-" + actionId;
    const write = (p: string, data: Buffer, mode: number) =>
      new Promise<void>((resolve, reject) => {
        const stream = sftp.createWriteStream(p, { flags: "wx", mode });
        stream.on("error", () => reject(new LakeError("unknown_effect")));
        stream.on("close", () => resolve());
        stream.end(data);
      });
    try {
      await write(backupPath, old.data, 0o600);
      await write(tempPath, Buffer.from(artifact.content), old.mode);
      await new Promise<void>((resolve, reject) =>
        sftp.chown(tempPath, old.uid, old.gid, (e) =>
          e
            ? reject(
                new LakeError(
                  "precondition_failed",
                  "Configuration ownership cannot be preserved",
                ),
              )
            : resolve(),
        ),
      );
      const check = await this.executeManaged(
        resource,
        binding.checkArgv.map((v) => v.replaceAll("{{file}}", tempPath)),
        signal,
      );
      requireCondition(
        check.exitCode === 0,
        "precondition_failed",
        "Configuration syntax check failed",
      );
      requireCondition(
        (await this.rawConfig(resource, path)).hash === expectedHash,
        "precondition_failed",
        "Configuration drifted",
      );
      await new Promise<void>((resolve, reject) =>
        sftp.ext_openssh_rename(tempPath, path, (e) =>
          e ? reject(new LakeError("unknown_effect")) : resolve(),
        ),
      );
      const output = await this.executeManaged(
        resource,
        ["systemctl", binding.action, "--", binding.unit],
        signal,
        true,
      );
      requireCondition(
        output.exitCode === 0,
        "unknown_effect",
        "Service effect requires reconciliation",
      );
      return {
        oldHash: expectedHash,
        newHash: sha256(artifact.content),
        backupPath,
        unit: binding.unit,
      };
    } finally {
      sftp.end();
      old.data.fill(0);
    }
  }
  async rollbackConfig(
    resource: Resource,
    path: string,
    newHash: string,
    backupPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const binding = configBinding(resource, path),
      current = await this.rawConfig(resource, path);
    requireCondition(
      current.hash === newHash,
      "precondition_failed",
      "External drift prevents rollback",
    );
    requireCondition(
      backupPath.startsWith(path + ".lake-backup-"),
      "scope_denied",
    );
    const sftp = await this.sftp(resource);
    try {
      await new Promise<void>((resolve, reject) =>
        sftp.chown(backupPath, current.uid, current.gid, (e) =>
          e ? reject(new LakeError("unknown_effect")) : resolve(),
        ),
      );
      await new Promise<void>((resolve, reject) =>
        sftp.chmod(backupPath, current.mode, (e) =>
          e ? reject(new LakeError("unknown_effect")) : resolve(),
        ),
      );
      await new Promise<void>((resolve, reject) =>
        sftp.ext_openssh_rename(backupPath, path, (e) =>
          e ? reject(new LakeError("unknown_effect")) : resolve(),
        ),
      );
      const result = await this.executeManaged(
        resource,
        ["systemctl", binding.action, "--", binding.unit],
        signal,
        true,
      );
      requireCondition(result.exitCode === 0, "unknown_effect");
    } finally {
      sftp.end();
    }
  }
  async execute(
    capability: string,
    resource: Resource,
    parameters: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const operation = capability.split(".").at(-1)!;
    let argv: string[];
    if (operation === "host_snapshot") argv = ["uname", "-a"];
    else if (operation === "service_status") {
      allowedUnit(resource, String(parameters.unit));
      argv = [
        "systemctl",
        "show",
        "--property=ActiveState,SubState,MainPID,InvocationID",
        "--",
        String(parameters.unit),
      ];
    } else if (operation === "read_log") {
      allowedUnit(resource, String(parameters.unit));
      argv = [
        "journalctl",
        "--no-pager",
        "-u",
        String(parameters.unit),
        "-n",
        String(parameters.lines ?? 100),
      ];
    } else if (operation === "read_config")
      return toolResult(
        await this.readConfig(resource, String(parameters.path)),
        { retryPolicy: "safe_read" },
      );
    else if (operation === "service_action") {
      allowedUnit(resource, String(parameters.unit));
      requireCondition(
        ["start", "reload", "restart"].includes(String(parameters.action)),
        "scope_denied",
      );
      argv = [
        "systemctl",
        String(parameters.action),
        "--",
        String(parameters.unit),
      ];
    } else throw new LakeError("capability_unavailable");
    const result = await this.executeManaged(
      resource,
      argv,
      signal,
      operation === "service_action",
    );
    requireCondition(
      result.exitCode === 0,
      "capability_unavailable",
      "SSH capability failed",
    );
    return toolResult(
      { ...result, observedAt: new Date().toISOString() },
      { retryPolicy: operation === "service_action" ? "never" : "safe_read" },
    );
  }
  async close(): Promise<void> {
    await this.pool.close((client) => client.end());
  }
}
