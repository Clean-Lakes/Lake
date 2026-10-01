import type { JsonValue } from "./json.js";
import { object, redact, text, type Params } from "./validation.js";
import { sanitizeSnapshot } from "./ui.js";
import { sanitizeReport } from "./report.js";
import { checkedAnswers, checkedQuestions } from "./questions.js";

type FieldType = "string" | "bool" | "int" | "signed_int" | "presentation_error" | "visual_report" | "a2ui";
const EXECUTION: Record<string, FieldType> = { actor: "string", id: "string", sequence: "int", scope_id: "string", target: "string", session_id: "string", working_directory: "string", next_directory: "string", user: "string", command: "string", stdout: "string", stderr: "string", status: "string", error: "string", exit_code: "signed_int", duration_ms: "int", truncated: "bool" };
const EVENT_FIELDS: Record<string, Record<string, FieldType>> = {
  user: { preview: "string", truncated: "bool" }, assistant: { preview: "string", truncated: "bool" }, assistant_progress: { preview: "string" }, run_started: { model: "string" },
  tool_proposed: { tool_name: "string", target: "string", arguments_sha256: "string", preview: "string", mcp_server: "string", mcp_tool: "string", activity_kind: "string", activity_action: "string", activity_count: "int" },
  tool_decision: { outcome: "string", reason: "string" }, tool_finished: { status: "string", preview: "string", duration_ms: "int", error_code: "presentation_error" }, model_usage: { input_tokens: "int", output_tokens: "int", estimated: "bool" }, summary_created: { through_seq: "int", token_estimate: "int" }, answer_finished: { status: "string" }, run_failed: { reason: "string" }, specialist: { name: "string", status: "string", preview: "string" },
  workflow: { run_id: "string", name: "string", status: "string", step_name: "string", step_status: "string", completed: "int", total: "int", planning_json: "string" }, skill_loaded: { name: "string", scope: "string", sha256: "string" },
  workflow_saved: { definition_id: "string", version: "int", name: "string", lake: "string", revision: "int" },
  question_asked: { question_id: "string", questions_json: "string" }, question_answered: { question_id: "string", answers_json: "string" }, visual_report: { report_id: "string", report_json: "visual_report" }, a2ui: { ui_json: "a2ui" }, ui_action: { surface_id: "string", component_id: "string", name: "string", context_sha256: "string" },
  terminal_proposed: { proposal_id: "string", command: "string", target: "string", kind: "string" }, terminal_control: { proposal_id: "string", owner: "string", status: "string" }, execution_started: EXECUTION, execution_finished: EXECUTION,
};
export function checkedEvent(kind: string, input: JsonValue): Params {
  const allowed = EVENT_FIELDS[kind], values = { ...object(input) };
  if (!allowed || new TextEncoder().encode(JSON.stringify(values)).length > 64 * 1024) throw new Error("无效的事件类型或大小");
  for (const [key, value] of Object.entries(values)) {
    const type = allowed[key]; if (!type) throw new Error("事件包含不允许的字段");
    if (type === "int" || type === "signed_int") { if (typeof value !== "number" || !Number.isSafeInteger(value) || (type === "int" && value < 0)) throw new Error("事件数字无效"); }
    else if (type === "bool") { if (typeof value !== "boolean") throw new Error("事件布尔值无效"); }
    else {
      if (typeof value !== "string") throw new Error("事件文字无效");
      if (type === "presentation_error" && !["invalid_ui", "invalid_report", "presentation_unavailable"].includes(value)) throw new Error("展示错误码无效");
      else if (type === "a2ui") values[key] = JSON.stringify(sanitizeSnapshot(JSON.parse(value) as JsonValue));
      else if (type === "visual_report") values[key] = JSON.stringify(sanitizeReport(JSON.parse(value) as JsonValue));
      else if (kind === "question_asked" && key === "questions_json") values[key] = JSON.stringify(checkedQuestions(JSON.parse(value) as JsonValue));
      else if (kind === "question_answered" && key === "answers_json") values[key] = JSON.stringify(checkedAnswers(JSON.parse(value) as JsonValue));
      else values[key] = redact(value, 64 * 1024);
    }
  }
  if (kind === "visual_report" && (!text(values, "report_id") || text(values, "report_id").length > 128 || !values.report_json)) throw new Error("报告标识无效");
  if ((kind === "question_asked" || kind === "question_answered") && (!text(values, "question_id") || text(values, "question_id").length > 128)) throw new Error("问题标识无效");
  if (new TextEncoder().encode(JSON.stringify(values)).length > 64 * 1024) throw new Error("事件净化后超过大小限制"); return values;
}
