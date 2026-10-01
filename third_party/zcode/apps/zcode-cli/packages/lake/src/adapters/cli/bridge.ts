import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { LakeCLIContext } from "../../domain/cli.js";
import type { LakeRuntime } from "../../domain/protocol.js";
import { object, redact, text } from "../../domain/validation.js";

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
        } else if (type === "ask") {
          if (active) throw new Error("上一轮对话仍在进行");
          if (!id) throw new Error("请求需要 id"); active = id;
          const task = runtime.dispatch({ method: "conversation.ask", id, params: { ...request, id: conversation } });
          tasks.push(task.catch(() => {}).finally(() => { if (active === id) active = ""; }));
        } else if (type === "approval") await runtime.dispatch({ method: "approval.respond", params: { id, approved: request.approved === true } });
        else if (type === "cancel") { if (active) await runtime.dispatch({ method: "execution.cancel", params: { id: active } }); }
        else throw new Error(`未知请求类型 ${type}`);
      } catch (error) { emit({ type: "error", id, error: redact(error instanceof Error ? error.message : String(error)) }); }
    }
  } finally {
    if (active) await runtime.dispatch({ method: "execution.cancel", params: { id: active } }).catch(() => {});
    await Promise.allSettled(tasks); unsubscribe(); lines.close();
  }
}
