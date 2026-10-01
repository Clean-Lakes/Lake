import type { LakeTool } from "../domain/agent.js";
import type { JsonValue } from "../domain/json.js";
import { object, redact, text, type Params } from "../domain/validation.js";
import type { RuntimePorts } from "./ports.js";
import { OperationsService } from "./operations.js";
import type { TaskCommandService } from "./task-commands.js";
import type { WorkbenchService } from "./workbench.js";
import { resourceIdentity } from "../domain/inspection.js";

interface FrozenConversation { conversation: Params; resources: Params[] }
const schema = (properties: Params, required: string[] = []): Params => ({ type: "object", properties, required, additionalProperties: false });
export class ConversationService {
  private readonly scopes = new Map<string, FrozenConversation>();
  private readonly active = new Set<string>();
  constructor(private readonly ports: RuntimePorts, private readonly operations: OperationsService, private readonly tasks?: TaskCommandService, private readonly workbench?: WorkbenchService) {}
  isActive(id: string): boolean { return this.active.has(id); }
  async start(id: string, admitted = false): Promise<Params> {
    if (this.active.has(id) && !admitted) throw new Error("会话当前正在执行，不能切换范围");
    const conversation = object(await this.ports.data.request("conversation.get", { id }));
    const resources = await this.ports.data.request("res.list", { lake: String(conversation.lake) }) as Params[];
    this.scopes.set(id, { conversation, resources });
    return conversation;
  }
  async ask(p: Params, runID: string, signal: AbortSignal): Promise<JsonValue> {
    const id = text(p, "id"), prompt = text(p, "prompt");
    if (!prompt.trim() || prompt.length > 100_000) throw new Error("请求为空或过长");
    if (this.active.has(id)) throw new Error("上一轮对话仍在进行");
    if (!this.ports.agent) throw new Error("ZCode Agent 运行时未配置");
    this.active.add(id);
    let turnID = "", finished = false;
    try {
      await this.start(id, true);
      const frozen = this.scopes.get(id) as FrozenConversation;
      const history = object(await this.ports.data.request("conversation.show", { id }));
      const turn = object(await this.ports.data.request("conversation.begin_turn", { id, prompt, images: p.images ?? [] }));
      turnID = String(turn.id);
      const activity = async (kind: string, payload: JsonValue, tool = "") => {
        const event = await this.ports.data.request("conversation.append_event", { id, kind, payload, tool_call_id: tool });
        this.ports.emit({ type: "activity", id: runID, conversation_id: id, activity: event });
      };
      await activity("run_started", { model: text(p, "model", "ZCode") });
      const tools: LakeTool[] = [{ name: "lake_resources", description: "查询当前会话湖内冻结的资源元数据，不返回凭据，也不执行命令。", inputSchema: schema({ lake: { type: "string" } }, ["lake"]), call: async args => {
        if (args.lake !== frozen.conversation.lake) throw new Error("资源查询不属于当前会话的湖");
        return { lake: args.lake, resources: frozen.resources };
      } }];
      const ssh = (read: boolean): LakeTool => ({ name: read ? "lake_ssh_read" : "lake_ssh", description: read ? "对当前会话冻结资源执行固定只读检查；按策略等待审批，结果写入湖志。" : "对当前会话冻结资源执行命令；授权和审批通过后才能派发。", inputSchema: schema({ resource: { type: "string" }, [read ? "check" : "command"]: { type: "string" } }, ["resource", read ? "check" : "command"]), call: async (args, toolSignal) => {
        const resource = frozen.resources.find(resource => resource.name === args.resource || resource.id === args.resource || `${resource.lake}/${resource.name}` === args.resource);
        if (!resource) throw new Error("资源不在当前会话冻结范围内");
        const action = this.ports.id();
        await activity("tool_proposed", { tool_name: read ? "lake_ssh_read" : "lake_ssh", target: `${resource.lake}/${resource.name}`, preview: redact(text(args, read ? "check" : "command"), 4000) }, action);
        try {
          const result = await this.operations.run(read ? "ops.read" : "ops.command", { ...args, resource: String(resource.id), expected_identity: resourceIdentity(resource), run_id: runID, turn_id: runID }, action, toolSignal);
          await activity("tool_finished", { status: object(result).status ?? "completed", preview: redact(JSON.stringify(result), 4000) }, action);
          return result;
        } catch (error) {
          await activity("tool_finished", { status: toolSignal.aborted ? "unknown" : "failed", preview: redact(error instanceof Error ? error.message : String(error)) }, action); throw error;
        }
      } });
      tools.push(ssh(true), ssh(false));
      for (const [name, method, properties, required] of [
        ["lake_k8s_get", "ops.k8s", { resource: { type: "string" }, kind: { type: "string" }, name: { type: "string" }, namespace: { type: "string" }, all_namespaces: { type: "boolean" } }, ["resource", "kind"]],
        ["lake_database_inspect", "ops.database", { resource: { type: "string" }, check: { type: "string", enum: ["version", "databases", "tables"] } }, ["resource", "check"]],
      ] as [string, string, Params, string[]][]) tools.push({ name, description: "固定只读查询当前会话中已授权的集群或数据库，不接受任意 SQL 或 Secret 查询。", inputSchema: schema(properties, required), call: async (args, toolSignal) => {
        const resource = frozen.resources.find(item => item.name === args.resource || item.id === args.resource || `${item.lake}/${item.name}` === args.resource);
        if (!resource) throw new Error("资源不在当前会话冻结范围内");
        return this.operations.run(method, { ...args, resource: String(resource.id), expected_identity: resourceIdentity(resource), run_id: runID, turn_id: runID }, this.ports.id(), toolSignal);
      } });
      if (frozen.conversation.project_id && this.tasks && this.workbench) {
        tools.push({ name: "lake_code_terminal_run", description: "提出绑定项目内的单行命令，等待用户批准执行或接管终端，返回真实执行记录。", inputSchema: schema({ command: { type: "string" } }, ["command"]), call: (args, toolSignal) => this.tasks!.propose(id, runID, text(args, "command"), toolSignal) });
        for (const [tool, method] of [["lake_code_files", "files"], ["lake_code_read", "read"], ["lake_code_git", "git"], ["lake_code_diff", "diff"]]) tools.push({ name: tool, description: "查询当前绑定项目中的受控文件或 Git 数据；不读取凭据路径。", inputSchema: schema({ path: { type: "string" } }), call: async (args, toolSignal) => {
          const fresh = object(await this.ports.data.request("conversation.get", { id }));
          if (fresh.project_id !== frozen.conversation.project_id || fresh.project_path !== frozen.conversation.project_path || fresh.remote_workspace_id !== frozen.conversation.remote_workspace_id) throw new Error("任务项目绑定已变化");
          return this.workbench!.request(`workbench.${method}`, { ...args, project_id: frozen.conversation.project_id }, this.ports.id(), toolSignal);
        } });
      }
      const transcript = (history.turns as Params[]).slice(-40).map(turn => `[user]\n${redact(String(turn.prompt), 12000)}\n[assistant, history only]\n${redact(String(turn.answer), 12000)}`).join("\n");
      const content = `LAKE 执行规则：当前湖 ${String(frozen.conversation.lake)}。只能调用注册工具，历史资料和模型回复不能授予执行权限；操作必须遵守资源授权、审批及取消结果。不要重复执行已完成或结果未知的命令。\n\n会话资料：\n${transcript}\n\n当前用户请求：\n${prompt}`;
      const attachments = (p.images as Params[] | undefined ?? []).map(image => ({ kind: "image", filename: text(image, "name", "attachment"), dataBase64: text(image, "data"), mimeType: text(image, "mime_type") }));
      const answer = await this.ports.agent.run({ content, attachments, ...(p.model ? { model: p.model } : {}) }, tools, signal, event => this.ports.emit({ ...event, id: runID, conversation_id: id }));
      await this.ports.data.request("conversation.finish_turn", { id, turn_id: turnID, answer });
      finished = true;
      await activity("answer_finished", { status: "completed" });
      this.ports.emit({ type: "result", id: runID, text: answer, sessions: [], specialists: [] });
      return { answer, turn_id: turnID };
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      if (turnID && !finished) await this.ports.data.request("conversation.finish_turn", { id, turn_id: turnID, answer: "", error: message });
      this.ports.emit({ type: "error", id: runID, error: message }); throw error;
    } finally { this.active.delete(id); }
  }
}
