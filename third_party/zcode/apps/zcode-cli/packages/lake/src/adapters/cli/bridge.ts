import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { LakeCLIContext } from "../../domain/cli.js";
import type { LakeRuntime } from "../../domain/protocol.js";
import { object, redact, text, type Params } from "../../domain/validation.js";

export async function runBridge(context: LakeCLIContext, runtime: LakeRuntime, conversation: string): Promise<void> {
  let sequence = 0, active = "";
  const emit = (event: object) => context.stdout.write(JSON.stringify({ ...event, version: 1, sequence: ++sequence }) + "\n");
  const unsubscribe = runtime.subscribe(emit);
  const scope = object(await runtime.dispatch({ method: "conversation.start", params: { id: conversation } }));
  const settings = object(await runtime.dispatch({ method: "settings", params: { action: "get" } }));
  emit({ type: "ready", model: settings.current_model, lake: scope.lake });
  const lines = createInterface({ input: Readable.from(context.stdin), crlfDelay: Infinity });
  const tasks: Promise<unknown>[] = [];
  try {
    for await (const line of lines) {
      let request;
      try { request = object(JSON.parse(line)); }
      catch { emit({ type: "error", error: "无效的 JSON 请求" }); continue; }
      const id = text(request, "id"), type = text(request, "type");
      try {
        if (request.version !== undefined && request.version !== 1) throw new Error("当前仅支持协议版本 1");
        if (type === "hello") {
          if (request.version !== 1) throw new Error("hello 需要协议版本 1"); emit({ type: "hello", id });
        } else if (["ask", "workflow_run", "workflow_v2_run", "specialist_resume", "ui_action"].includes(type)) {
          if (active) throw new Error("上一轮对话仍在进行");
          if (!id) throw new Error("请求需要 id"); active = id;
          const extras: Params = type === "workflow_run" ? { workflow: request.workflow } : type === "workflow_v2_run" ? { workflow_v2: request.workflow_v2 } : type === "specialist_resume" ? { specialist_resume: request.specialist_resume } : {};
          const task = runtime.dispatch({ method: "conversation.ask", id, params: { ...request, ...extras, id: conversation, prompt: request.prompt ?? (type === "ui_action" ? "处理用户点击的界面操作" : "") } });
          tasks.push(task.catch(() => {}).finally(() => { if (active === id) active = ""; }));
        } else if (type === "approval" || type === "approve") await runtime.dispatch({ method: "approval.respond", params: { id, approved: request.approved === true } });
        else if (type === "question_answer") {
          try { await runtime.dispatch({ method: "question.answer", params: { id: conversation, run_id: id, question_id: request.question_id, answers: request.answers } }); emit({ type: "question_answered", id, question_id: request.question_id, answers: request.answers }); }
          catch (error) { emit({ type: "question_error", id, question_id: request.question_id, error: redact(error instanceof Error ? error.message : String(error)) }); }
        }
        else if (type === "cancel" || type === "close") { if (active) await runtime.dispatch({ method: "execution.cancel", params: { id: active } }); if (type === "close") break; }
        else throw new Error(`未知请求类型 ${type}`);
      } catch (error) { emit({ type: "error", id, error: redact(error instanceof Error ? error.message : String(error)) }); }
    }
  } finally {
    if (active) await runtime.dispatch({ method: "execution.cancel", params: { id: active } }).catch(() => {});
    await Promise.allSettled(tasks); unsubscribe(); lines.close();
  }
}
