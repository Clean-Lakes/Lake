import type { JsonValue } from "../domain/json.js";
import { integer, object, redact, text, type Params } from "../domain/validation.js";
import { terminalCommand } from "../domain/workspace.js";
import type { RuntimePorts } from "./ports.js";
import { WorkbenchService } from "./workbench.js";

interface Proposal { id: string; conversationID: string; runID: string; command: string; conversation: Params; owner: "agent" | "user"; running: boolean; dispatched: boolean; after: number; signal: AbortSignal; finish(result: JsonValue): void; fail(error: Error): void }
interface TaskTerminal { scopeID: string; conversation: Params; sessionID: string; status: Params; running: boolean }
const scopeID = (conversation: Params): string => text(conversation, "remote_workspace_id") || text(conversation, "project_id");
const scopePath = (conversation: Params): string => text(conversation, "remote_root") || text(conversation, "project_path");
export class TaskCommandService {
  private readonly proposals = new Map<string, Proposal>();
  private readonly terminals = new Map<string, TaskTerminal>();
  constructor(private readonly ports: RuntimePorts, private readonly workbench: WorkbenchService, private readonly agentBusy: (conversationID: string) => boolean) {}
  private async event(conversationID: string, kind: string, payload: JsonValue, tool = "", actor = "agent"): Promise<Params> {
    return object(await this.ports.data.request("conversation.append_event", { id: conversationID, kind, payload, tool_call_id: tool, actor }));
  }
  async propose(conversationID: string, runID: string, body: string, signal: AbortSignal): Promise<JsonValue> {
    terminalCommand(body); signal.throwIfAborted();
    const conversation = object(await this.ports.data.request("conversation.get", { id: conversationID }));
    if (!scopeID(conversation)) throw new Error("当前任务未绑定代码项目");
    const id = this.ports.id(), target = scopePath(conversation), kind = conversation.remote_workspace_id ? "remote" : "local", proposed = await this.event(conversationID, "terminal_proposed", { proposal_id: id, command: redact(body, 4000), target, kind }, id);
    return new Promise<JsonValue>((finish, fail) => {
      const proposal: Proposal = { id, conversationID, runID, command: body, conversation, owner: "agent", running: false, dispatched: false, after: Number(proposed.sequence), signal, finish: result => { signal.removeEventListener("abort", abort); finish(result); }, fail: error => { signal.removeEventListener("abort", abort); fail(error); } };
      const abort = () => { this.proposals.delete(id); proposal.fail(new Error("原任务已取消")); this.ports.emit({ type: "command_control", proposal_id: id, conversation_id: conversationID, status: "resolved" }); };
      this.proposals.set(id, proposal); signal.addEventListener("abort", abort, { once: true });
      this.ports.emit({ type: "command_proposed", id: runID, tool_call_id: id, proposal_id: id, conversation_id: conversationID, command: redact(body, 4000), path: target, kind, after_sequence: proposed.sequence, working_directory: this.terminals.get(conversationID)?.status.directory ?? target });
      if (signal.aborted) abort();
    });
  }
  private proposal(id: string, owner: string, claim: boolean): Proposal {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.owner !== owner || proposal.running || proposal.signal.aborted) throw new Error("命令提案已结束或控制权已变化");
    if (claim) proposal.running = true; return proposal;
  }
  async request(method: string, p: Params, actionID: string, signal: AbortSignal): Promise<JsonValue> {
    const id = text(p, "id");
    if (method === "task.run") return this.run(id, text(p, "command"), "user", actionID, signal);
    if (method === "task.status") { const terminal = this.terminals.get(id); return terminal ? this.status(id, terminal, signal) : null; }
    if (method === "task.close") {
      if ([...this.proposals.values()].some(proposal => proposal.conversationID === id)) throw new Error("当前任务等待终端交接，完成后才能关闭");
      const terminal = this.terminals.get(id); if (terminal?.running) throw new Error("终端命令正在执行");
      if (terminal) { await this.workbench.request("workbench.terminal.close", { id: terminal.sessionID }, actionID, signal); this.terminals.delete(id); } return null;
    }
    if (method === "task.take") {
      const proposal = this.proposal(id, "agent", true);
      try { await this.event(proposal.conversationID, "terminal_control", { proposal_id: id, owner: "user", status: "waiting" }, id, "user"); proposal.owner = "user"; this.ports.emit({ type: "command_control", proposal_id: id, conversation_id: proposal.conversationID, status: "taken" }); return null; }
      finally { proposal.running = false; }
    }
    const proposal = this.proposal(id, method === "task.return" ? "user" : "agent", true);
    try {
      if (method === "task.decline") { await this.resolve(proposal, null, new Error("用户拒绝此命令；停止该操作")); return null; }
      if (method === "task.return") {
        const record = object(await this.ports.data.request("conversation.execution", { id: proposal.conversationID, sequence: integer(p, "sequence") })), fresh = object(await this.ports.data.request("conversation.get", { id: proposal.conversationID }));
        if (record.actor !== "user" || Number(record.sequence) <= proposal.after || record.scope_id !== scopeID(fresh) || scopePath(fresh) !== scopePath(proposal.conversation) || scopeID(fresh) !== scopeID(proposal.conversation)) throw new Error("请先在同一任务工作区执行命令，再交回本次结果");
        await this.resolve(proposal, record); return record;
      }
      if (method !== "task.proposed_run") throw new Error("未知的任务终端操作");
      const record = await this.run(proposal.conversationID, proposal.command, "agent", actionID, proposal.signal, proposal);
      await this.resolve(proposal, record); return record;
    } catch (error) {
      if (this.proposals.has(id)) {
        // 已派发的提案不能因记录或传输失败重新变成可点击的待执行命令。
        if (proposal.dispatched) { this.proposals.delete(id); proposal.fail(new Error("命令结果记录失败；核对执行记录后再操作")); }
        else proposal.running = false;
      }
      throw error;
    }
  }
  private async resolve(proposal: Proposal, record: JsonValue, error?: Error): Promise<void> {
    if (this.proposals.get(proposal.id) !== proposal || proposal.signal.aborted) throw new Error("原任务已结束");
    try { await this.event(proposal.conversationID, "terminal_control", { proposal_id: proposal.id, owner: "agent", status: "resolved" }, proposal.id, "user"); }
    catch (failure) { this.proposals.delete(proposal.id); proposal.fail(new Error("命令交接记录失败，原提案已结束")); throw failure; }
    this.proposals.delete(proposal.id);
    this.ports.emit({ type: "command_control", proposal_id: proposal.id, conversation_id: proposal.conversationID, status: "resolved" });
    if (error) proposal.fail(error); else proposal.finish(record);
  }
  private async status(id: string, terminal: TaskTerminal, signal: AbortSignal): Promise<JsonValue> {
    const conversation = object(await this.ports.data.request("conversation.get", { id }));
    if (scopeID(conversation) !== terminal.scopeID || scopePath(conversation) !== scopePath(terminal.conversation)) return null;
    const status = object(await this.workbench.request("workbench.terminal.status", { id: terminal.sessionID }, "", signal));
    if (status.closed) return null;
    return { scope_id: terminal.scopeID, ...status, kind: conversation.remote_workspace_id ? "remote" : "local", target: conversation.remote_workspace_id ? text(conversation, "remote_host", "远程主机") : "本机", running: terminal.running };
  }
  private async run(id: string, body: string, actor: string, actionID: string, signal: AbortSignal, proposal?: Proposal): Promise<JsonValue> {
    terminalCommand(body);
    if (actor === "user" && this.agentBusy(id) && ![...this.proposals.values()].some(proposal => proposal.conversationID === id && proposal.owner === "user" && !proposal.running)) throw new Error("Lake 正在处理任务，请先选择“这一步我来”");
    const conversation = object(await this.ports.data.request("conversation.get", { id })), project = object(await this.ports.data.request(conversation.remote_workspace_id ? "code.remote.get" : "code.get", { id: scopeID(conversation) })), root = project.path ?? project.remote_root;
    if (project.lake_id !== conversation.lake_id || root !== scopePath(conversation)) throw new Error("任务工作区绑定已变化");
    let terminal = this.terminals.get(id);
    if (terminal?.running) throw new Error("任务终端已有命令正在执行");
    if (terminal?.sessionID) {
      const state = object(await this.workbench.request("workbench.terminal.status", { id: terminal.sessionID }, actionID, signal));
      if (state.closed) { await this.workbench.request("workbench.terminal.close", { id: terminal.sessionID }, actionID, signal); terminal = undefined; }
    }
    if (terminal && (terminal.scopeID !== project.id || scopePath(terminal.conversation) !== root)) { await this.workbench.request("workbench.terminal.close", { id: terminal.sessionID }, actionID, signal); terminal = undefined; }
    if (!terminal) { terminal = { scopeID: text(project, "id"), conversation, sessionID: "", status: {}, running: false }; this.terminals.set(id, terminal); }
    terminal.running = true; let record: Params = {};
    const append = async (value: Params): Promise<Params> => {
      const saved = object(await this.ports.data.request("conversation.append_execution", { id, record: value }));
      this.ports.emit({ type: "execution", conversation_id: id, event: saved.event }); return object(saved.record);
    };
    try {
      const current = terminal;
      const result = await this.workbench.taskRun(project, terminal.sessionID, body, actionID, signal, async shell => {
        const fresh = object(await this.ports.data.request("conversation.get", { id }));
        if (scopeID(fresh) !== scopeID(conversation) || scopePath(fresh) !== scopePath(conversation) || fresh.remote_workspace_id !== conversation.remote_workspace_id) throw new Error("批准期间任务绑定已变化");
        current.sessionID = text(shell, "id"); current.status = shell;
        record = await append({ id: actionID, actor, scope_id: project.id, session_id: shell.id, working_directory: shell.directory, user: shell.user, target: conversation.remote_workspace_id ? `${project.username}@${project.host}:${project.port}` : "本机", command: body, status: "running", stdout: "", stderr: "", error: "", exit_code: -1, duration_ms: 0, truncated: false });
        if (proposal) proposal.dispatched = true;
      }, proposal ? async () => this.proposals.get(proposal.id) === proposal && proposal.running && !proposal.signal.aborted && proposal.command === body && scopeID(proposal.conversation) === scopeID(conversation) && scopePath(proposal.conversation) === scopePath(conversation) : undefined);
      current.status = object(result.terminal); const projection = { ...result }; delete projection.terminal;
      return append({ ...record, ...projection, actor, status: result.status ?? "unknown" });
    } catch (error) {
      if (record.id) await append({ ...record, status: "unknown", error: "命令已经派发，结果未能确认；核对后再操作", exit_code: -1 }).catch(() => {});
      throw error;
    } finally { terminal.running = false; }
  }
}
