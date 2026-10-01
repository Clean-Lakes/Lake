import { join } from "node:path";
import { homedir } from "node:os";
import type { JsonValue } from "../../domain/json.js";
import { hasControl, integer, object, text, type Params } from "../../domain/validation.js";
import type { ExecutionPort } from "../../app/ports.js";
import { FileVault } from "../vault.js";
import { runProcess } from "./process.js";
import { WorkspaceAdapter } from "../workspace/adapter.js";
import { InspectionTransport } from "./inspection.js";
import { RemoteWorkspaceAdapter } from "../workspace/remote.js";
import { LocalTerminal } from "../workspace/terminal.js";
import { remotePrefix } from "../../domain/remote.js";
import { shellQuote } from "../../domain/workspace.js";

export class OperationsTransport implements ExecutionPort {
  private readonly workspaces = new WorkspaceAdapter();
  private readonly inspections: InspectionTransport;
  private readonly remote = new RemoteWorkspaceAdapter((p, signal) => this.request("transport.ssh", p, signal), async (p, signal) => {
    const args = await this.sshArgs(p), root = text(p, "root"), user = text(object(object(p.resource).ssh), "username");
    signal.throwIfAborted();
    const terminal = new LocalTerminal(root, { executable: "ssh", args: [...args, "sh -c " + shellQuote(remotePrefix(root) + "exec sh 3>&1")], user, remote: true });
    const probe = await terminal.run("pwd -P", signal);
    if (probe.status !== "completed" || String(probe.stdout).trim() !== root) { await terminal.close(); throw new Error("远程终端根目录验证失败"); }
    return terminal;
  });
  constructor(private readonly vault: FileVault) { this.inspections = new InspectionTransport(vault); }
  async request(method: string, p: Params, signal: AbortSignal): Promise<JsonValue> {
    if (method.startsWith("workspace.")) return this.workspaces.request(method, p, signal);
    if (method.startsWith("remote.")) return this.remote.request(method, p, signal);
    if (method === "transport.k8s" || method === "transport.database") return this.inspections.request(method, p, signal);
    if (method === "transport.local") return runProcess(process.platform === "win32" ? "cmd.exe" : "/bin/sh", process.platform === "win32" ? ["/d", "/s", "/c", text(p, "command")] : ["-c", text(p, "command")], { cwd: text(p, "cwd"), signal, timeoutMS: integer(p, "timeout_ms", 120_000) });
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
  async close(): Promise<void> { await this.workspaces.close(); await this.remote.close(); }
}
