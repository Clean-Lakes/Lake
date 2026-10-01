import type { JsonValue } from "../../domain/json.js";
import { integer, text, type Params } from "../../domain/validation.js";
import type { ExecutionPort } from "../../app/ports.js";
import { listFiles, readLines, registeredRoot } from "./files.js";
import { gitDiff, gitOverview } from "./git.js";
import { LocalTerminal } from "./terminal.js";

export class WorkspaceAdapter implements ExecutionPort {
  private readonly terminals = new Map<string, LocalTerminal>();
  async request(method: string, p: Params, signal: AbortSignal): Promise<JsonValue> {
    const root = text(p, "root");
    switch (method) {
      case "workspace.validate": return registeredRoot(root);
      case "workspace.files": return listFiles(root, signal, text(p, "filter"));
      case "workspace.read": return readLines(root, text(p, "path"), Math.max(1, integer(p, "start", 1)), Math.min(200, Math.max(1, integer(p, "limit", 200))));
      case "workspace.git": return gitOverview(root, signal);
      case "workspace.diff": return gitDiff(root, text(p, "path"), signal);
      case "workspace.terminal.open": {
        await registeredRoot(root); signal.throwIfAborted();
        const terminal = new LocalTerminal(root); this.terminals.set(terminal.id, terminal); return terminal.view();
      }
      case "workspace.terminal.status": return this.terminals.get(text(p, "id"))?.view() ?? null;
      case "workspace.terminal.run": {
        const terminal = this.terminals.get(text(p, "id"));
        if (!terminal || terminal.root !== root) throw new Error("终端绑定的项目路径已变化");
        return terminal.run(text(p, "command"), signal);
      }
      case "workspace.terminal.close": {
        const id = text(p, "id"), terminal = this.terminals.get(id); this.terminals.delete(id); await terminal?.close(); return null;
      }
      default: throw new Error(`未知的工作区执行 ${method}`);
    }
  }
  async close(): Promise<void> { await Promise.allSettled([...this.terminals.values()].map(terminal => terminal.close())); this.terminals.clear(); }
}
