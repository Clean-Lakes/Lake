import type { JsonValue } from "../domain/json.js";
import { object, redact, text, type Params } from "../domain/validation.js";
import { checkedImages } from "../domain/images.js";
import type { RuntimePorts } from "./ports.js";
import type { OperationsService } from "./operations.js";
import type { WorkflowRunService } from "./workflow-run.js";
import { conversationTools } from "./conversation-tools.js";
import { nativeConversationInput } from "./conversation-input.js";
import { recordNativeEvent } from "./native-events.js";

export class ConversationService {
  private readonly active = new Set<string>();
  constructor(
    readonly ports: RuntimePorts,
    readonly operations: OperationsService,
    readonly workflows?: WorkflowRunService,
  ) {}
  isActive(id: string): boolean {
    return this.active.has(id);
  }
  async start(id: string): Promise<Params> {
    if (this.active.has(id)) throw new Error("会话当前正在执行，不能切换范围");
    return object(await this.ports.data.request("conversation.get", { id }));
  }
  async workflowTask(
    node: Params,
    call: Params,
    run: Params,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (!this.ports.agent) throw new Error("ZCode Agent 运行时未配置");
    const id = text(run, "conversation_id"),
      conversation = id
        ? object(await this.ports.data.request("conversation.get", { id }))
        : { lake_id: run.lake_id, lake: run.lake_id };
    if (conversation.lake_id !== run.lake_id) throw new Error("工作流任务的湖范围不匹配");
    const resources = run.resources as Params[],
      target = call.target
        ? resources.find((resource) => resource.name === call.target || resource.id === call.target)
        : undefined;
    if (call.target && !target) throw new Error("工作流任务资源超出范围");
    const tools = conversationTools(
      this,
      { conversation, resources: target ? [target] : resources },
      id,
      text(run, "id"),
      async () => {},
    );
    if (node.kind === "tool_call") {
      const tool = tools.find((tool) => tool.name === node.tool);
      if (!tool) throw new Error("运维工作流工具未注册");
      return tool.call(object(call.inputs), signal);
    }
    const answer = await this.ports.agent.run(
      {
        content: `运维工作流节点 ${text(node, "id")}：处理当前节点，操作仍须审批。\n${text(call, "request")}`,
        workspace: conversation.project_path ?? "",
        remote_workspace_id: conversation.remote_workspace_id ?? "",
        conversation_id: id,
        run_id: run.id,
        native_session_id: `workflow-${text(run, "id")}-${text(node, "id")}`,
        ...(node.kind === "specialist_task"
          ? {
              content: `使用 ZCode 的原生 Agent 工具委派给 ${text(node, "specialist")}，任务：${text(call, "request")}`,
            }
          : {}),
      },
      tools,
      signal,
      (event) => this.ports.emit({ ...event, id: run.id, conversation_id: id }),
    );
    return { answer };
  }
  async ask(p: Params, runID: string, signal: AbortSignal): Promise<JsonValue> {
    const id = text(p, "id"),
      images = checkedImages(p.images ?? []),
      prompt = text(p, "prompt");
    if ((!prompt.trim() && !images.length) || prompt.length > 100_000)
      throw new Error("请求为空或过长");
    if (this.active.has(id)) throw new Error("上一轮对话仍在进行");
    if (!this.ports.agent) throw new Error("ZCode Agent 运行时未配置");
    this.active.add(id);
    let turnID = "",
      finished = false;
    try {
      const conversation = object(await this.ports.data.request("conversation.get", { id })),
        resources = (await this.ports.data.request("res.list", {
          lake: conversation.lake,
        })) as Params[];
      const content = await nativeConversationInput(this.ports, conversation, p);
      signal.throwIfAborted();
      const history = object(await this.ports.data.request("conversation.show", { id }));
      const turn = object(
        await this.ports.data.request("conversation.begin_turn", { id, prompt, images }),
      );
      turnID = text(turn, "id");
      const frozen = {
        conversation: { ...conversation, current_user_seq: object(turn.event).sequence },
        resources,
      };
      let nativeEvents = Promise.resolve();
      const activity = async (kind: string, payload: JsonValue, tool = "") => {
        const event = await this.ports.data.request("conversation.append_event", {
          id,
          kind,
          payload,
          tool_call_id: tool,
        });
        this.ports.emit({ type: "activity", id: runID, conversation_id: id, activity: event });
      };
      await activity("run_started", { model: text(p, "model", "ZCode") });
      let tools = conversationTools(this, frozen, id, runID, activity),
        workflowResult: JsonValue = null;
      if (p.workflow || p.workflow_v2) {
        if (!this.workflows) throw new Error("工作流执行器未配置");
        const request = { ...object(p.workflow ?? p.workflow_v2) },
          v2 = !!p.workflow_v2;
        if (!v2 && !request.definition_id) {
          const definitions = (await this.ports.data.request("workflow.list", {
            lake: conversation.lake,
          })) as Params[];
          request.definition_id =
            definitions.find((definition) => definition.name === request.name)?.id ?? "";
        }
        workflowResult = await this.workflows.execute(
          {
            ...request,
            version: v2 ? 2 : 1,
            lake_id: conversation.lake_id,
            conversation_id: id,
            project_id: conversation.project_id,
          },
          runID,
          signal,
        );
      }
      if (p.review_only === true || workflowResult)
        tools = tools.filter((tool) => ["lake_conversation_history"].includes(tool.name));
      const answer = await this.ports.agent.run(
        {
          content: `${content}\n${workflowResult ? `运维工作流运行结果（只汇报，不重放）：${JSON.stringify(workflowResult)}` : ""}`,
          run_id: runID,
          conversation_id: id,
          native_session_id: id,
          workspace: conversation.project_path ?? "",
          remote_workspace_id: conversation.remote_workspace_id ?? "",
          lake: conversation.lake,
          history: history.turns,
          attachments: images.map((image) => ({
            kind: "image",
            filename: image.name,
            dataBase64: image.data,
            mimeType: image.mime_type,
          })),
          review_only: p.review_only === true || !!workflowResult,
          ...(p.model ? { model: p.model } : {}),
        },
        tools,
        signal,
        (event) => {
          nativeEvents = nativeEvents.then(() => recordNativeEvent(event, activity));
          void nativeEvents.catch(() => {});
          this.ports.emit({ ...event, id: runID, conversation_id: id });
        },
      );
      await nativeEvents;
      await this.ports.data.request("conversation.finish_turn", { id, turn_id: turnID, answer });
      finished = true;
      await activity("answer_finished", { status: "completed" });
      this.ports.emit({ type: "result", id: runID, text: answer, sessions: [], specialists: [] });
      return { answer, turn_id: turnID };
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      if (turnID && !finished)
        await this.ports.data.request("conversation.finish_turn", {
          id,
          turn_id: turnID,
          answer: "",
          error: message,
        });
      this.ports.emit({ type: "error", id: runID, error: message });
      throw error;
    } finally {
      this.active.delete(id);
    }
  }
}
