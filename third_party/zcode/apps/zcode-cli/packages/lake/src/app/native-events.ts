import type { JsonValue } from "../domain/json.js";
import type { LakeEvent } from "../domain/protocol.js";
import { object, redact, text } from "../domain/validation.js";

/** Mirrors presentation evidence only; native tool/checkpoint lifecycle stays in ZCode. */
export async function recordNativeEvent(
  event: LakeEvent,
  activity: (kind: string, payload: JsonValue, tool?: string) => Promise<void>,
): Promise<void> {
  if (event.type === "question") {
    const question = object(event.question as JsonValue);
    await activity("question_asked", {
      question_id: question.id ?? "",
      questions_json: JSON.stringify(question.questions),
    });
  } else if (event.type === "question_answered")
    await activity("question_answered", {
      question_id: String(event.question_id),
      answers_json: JSON.stringify(event.answers),
    });
  else if (event.type === "native_event") {
    const p = object(event.payload as JsonValue),
      tool = text(p, "toolCallId").slice(0, 128),
      name = text(p, "toolName");
    if (event.native_type === "tool.updated" && !name.startsWith("mcp__lake__")) {
      if (p.kind === "scheduled")
        await activity(
          "tool_proposed",
          {
            tool_name: name,
            preview: redact(JSON.stringify(p.input ?? {}), 4096),
            activity_kind:
              name === "Bash"
                ? "command"
                : name === "Read"
                  ? "read"
                  : name === "Edit"
                    ? "edit"
                    : name === "Write"
                      ? "create"
                      : ["Grep", "Glob", "WebSearch"].includes(name)
                        ? "search"
                        : name === "Agent"
                          ? "task"
                          : "tool",
            activity_action:
              name === "Bash"
                ? "运行命令"
                : name === "Read"
                  ? "读取文件"
                  : name === "Edit"
                    ? "修改文件"
                    : name === "Write"
                      ? "创建文件"
                      : name === "Agent"
                        ? "委派 Agent"
                        : `调用 ${name}`,
          },
          tool,
        );
      else if (p.kind === "result" || p.kind === "error")
        await activity(
          "tool_finished",
          {
            status:
              p.kind === "error" || object(p.result).isError === true ? "failed" : "completed",
            duration_ms: Math.round(Number(p.duration ?? 0)),
            preview: redact(JSON.stringify(p.result ?? {}), 4096),
          },
          tool,
        );
    }
  }
}
