import { createHash } from "node:crypto";
import type { JsonValue } from "../../domain/json.js";
import { remotePlan } from "../../domain/remote.js";
import { object, redact, text, type Params } from "../../domain/validation.js";
import { workspaceRelative } from "../../domain/workspace.js";
import { LocalTerminal } from "./terminal.js";

export class RemoteWorkspaceAdapter {
  private readonly terminals = new Map<string, { scope: string; terminal: LocalTerminal }>();
  constructor(private readonly ssh: (p: Params, signal: AbortSignal) => Promise<JsonValue>, private readonly open?: (p: Params, signal: AbortSignal) => Promise<LocalTerminal>) {}
  async request(method: string, p: Params, signal: AbortSignal): Promise<JsonValue> {
    if (method.startsWith("remote.terminal.")) {
      if (method === "remote.terminal.open") {
        if (!this.open) throw new Error("远程 Shell 适配器未配置");
        const terminal = await this.open(p, signal); this.terminals.set(terminal.id, { scope: JSON.stringify([p.resource, p.root, p.credential_ref]), terminal }); return terminal.view();
      }
      const id = text(p, "id"), lease = this.terminals.get(id);
      if (method === "remote.terminal.close") { this.terminals.delete(id); await lease?.terminal.close(); return null; }
      if (method === "remote.terminal.status") return lease?.terminal.view() ?? null;
      if (!lease || lease.scope !== JSON.stringify([p.resource, p.root, p.credential_ref])) throw new Error("远程终端绑定已变化");
      return lease.terminal.run(text(p, "command"), signal);
    }
    const plan = remotePlan(method, p), result = object(await this.ssh({ ...p, command: plan.command, input: plan.input ?? "" }, signal));
    if (result.status !== "completed" || result.truncated) {
      if (method === "remote.run" || method === "remote.write") return result;
      throw new Error("远程查询失败或超过输出上限");
    }
    const output = text(result, "stdout");
    if (method === "remote.probe") { if (output.trim() !== p.root) throw new Error("远程根目录不是规范物理路径"); return result; }
    if (method === "remote.files") {
      const files = output.split("\0").map(path => path.replace(/^\.\//u, "")).filter(path => { try { workspaceRelative(path); return true; } catch { return false; } }).slice(0, 200).sort();
      return { ...result, value: files };
    }
    if (method === "remote.read") {
      if (Buffer.byteLength(output) > 65536 || output.includes("\0") || output.includes("\ufffd")) throw new Error("远程文件不是有界 UTF-8 文本");
      return { ...result, value: { path: p.path, content: redact(output, 65536), sha256: result.stdout_sha256 ?? createHash("sha256").update(output).digest("hex") } };
    }
    if (method === "remote.write" && output.trim() !== createHash("sha256").update(text(p, "content")).digest("hex")) return { ...result, status: "unknown", error: "远程写入校验未能确认；请核对后再操作" };
    return result;
  }
  async close(): Promise<void> { await Promise.allSettled([...this.terminals.values()].map(lease => lease.terminal.close())); this.terminals.clear(); }
}
