import { join } from "node:path";
import { homedir } from "node:os";
import type { JsonValue } from "../../domain/json.js";
import { hasControl, integer, object, text, type Params } from "../../domain/validation.js";
import type { ExecutionPort } from "../../app/ports.js";
import { FileVault } from "../vault.js";
import { runProcess } from "./process.js";
import { InspectionTransport } from "./inspection.js";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";

export class OperationsTransport implements ExecutionPort {
  private readonly native = createNodeExecutionAdapter();
  private readonly inspections: InspectionTransport;
  constructor(private readonly vault: FileVault) { this.inspections = new InspectionTransport(vault); }
  async request(method: string, p: Params, signal: AbortSignal): Promise<JsonValue> {
    if (method === "transport.k8s" || method === "transport.database") return this.inspections.request(method, p, signal);
    if (method === "transport.local") {
      const result = await this.native.run({ command: { mode: "shell", command: text(p, "command") }, cwd: text(p, "cwd"), timeoutMs: integer(p, "timeout_ms", 120_000), outputLimit: { maxInlineBytes: 64 * 1024, persistOutput: "none" } }, { signal });
      return { status: result.status, stdout: result.stdout.text, stderr: result.stderr.text, exit_code: result.exitCode ?? -1, duration_ms: Math.round(result.durationMs), truncated: result.stdout.truncated || result.stderr.truncated };
    }
    if (method !== "transport.ssh") throw new Error(`未知的执行传输 ${method}`);
    const args = await this.sshArgs(p);
    signal.throwIfAborted();
    const result = await runProcess("ssh", [...args, text(p, "command")], { signal, timeoutMS: integer(p, "timeout_ms", 120_000), input: text(p, "input") });
    if (result.exit_code === 255) { result.status = "unknown"; result.error = "SSH 连接失败或中断，不能确定远端命令是否执行"; }
    return result;
  }
  private async sshArgs(p: Params): Promise<string[]> {
    const resource = object(p.resource), ssh = object(resource.ssh), host = text(ssh, "host"), username = text(ssh, "username");
    if (!host || host.startsWith("-") || hasControl(host) || /\s/u.test(host) || !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/u.test(username)) throw new Error("SSH 连接参数无效");
    const ref = text(p, "credential_ref");
    if (!ref.startsWith("file:ssh/")) throw new Error("SSH 必须使用已迁移的私钥引用");
    const keyPath = await this.vault.referencePath(ref);
    return ["-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "PasswordAuthentication=no", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${join(homedir(), ".ssh", "known_hosts")}`, "-o", "ConnectTimeout=10", "-i", keyPath, "-p", String(integer(ssh, "port", 22)), `${username}@${host}`];
  }
  async close(): Promise<void> { await this.native.close?.(); }
}
