import { join } from "node:path";
import { homedir } from "node:os";
import type { JsonValue } from "../../domain/json.js";
import { hasControl, integer, object, text, type Params } from "../../domain/validation.js";
import type { ExecutionPort } from "../../app/ports.js";
import { FileVault } from "../vault.js";
import { runProcess } from "./process.js";
import { WorkspaceAdapter } from "../workspace/adapter.js";

export class OperationsTransport implements ExecutionPort {
  private readonly workspaces = new WorkspaceAdapter();
  constructor(private readonly vault: FileVault) {}
  async request(method: string, p: Params, signal: AbortSignal): Promise<JsonValue> {
    if (method.startsWith("workspace.")) return this.workspaces.request(method, p, signal);
    if (method === "transport.local") return runProcess(process.platform === "win32" ? "cmd.exe" : "/bin/sh", process.platform === "win32" ? ["/d", "/s", "/c", text(p, "command")] : ["-c", text(p, "command")], { cwd: text(p, "cwd"), signal, timeoutMS: integer(p, "timeout_ms", 120_000) });
    if (method !== "transport.ssh") throw new Error(`未知的执行传输 ${method}`);
    const resource = object(p.resource), ssh = object(resource.ssh), host = text(ssh, "host"), username = text(ssh, "username");
    if (!host || host.startsWith("-") || hasControl(host) || /\s/u.test(host) || !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/u.test(username)) throw new Error("SSH 连接参数无效");
    const ref = text(p, "credential_ref");
    if (!ref.startsWith("file:ssh/")) throw new Error("SSH 必须使用已迁移的私钥引用");
    const keyPath = await this.vault.referencePath(ref);
    signal.throwIfAborted();
    const args = ["-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "PasswordAuthentication=no", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${join(homedir(), ".ssh", "known_hosts")}`, "-o", "ConnectTimeout=10", "-i", keyPath, "-p", String(integer(ssh, "port", 22)), `${username}@${host}`, text(p, "command")];
    const result = await runProcess("ssh", args, { signal, timeoutMS: integer(p, "timeout_ms", 120_000) });
    if (result.exit_code === 255) { result.status = "unknown"; result.error = "SSH 连接失败或中断，不能确定远端命令是否执行"; }
    return result;
  }
  async close(): Promise<void> { await this.workspaces.close(); }
}
