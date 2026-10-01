import type { JsonValue } from "./json.js";
import { fields } from "./presentation-json.js";
import { object, text, type Params } from "./validation.js";

export const TASK_GROUPS = ["goals", "constraints", "reported_results", "pending", "next_steps", "references"];
export const TASK_CREDENTIAL = /-----BEGIN .*PRIVATE KEY|authorization\s*:|bearer\s+|api[_-]?key\s*[:=]|password\s*[:=]|passwd\s*[:=]|access[_-]?token\s*[:=]|密码\s*[:：=]|私钥\s*[:：=]|密钥\s*[:：=]/iu;
export function validateTaskState(value: JsonValue, sources: number[]): Params | null {
  if (value === null) return null;
  const state = object(value); fields(state, ["version", ...TASK_GROUPS, "needs_review"]);
  if (state.version !== 1 || (state.needs_review !== undefined && typeof state.needs_review !== "boolean")) throw new Error("任务摘要版本无效");
  const allowed = new Set(sources.filter(source => source > 0));
  for (const group of TASK_GROUPS) {
    const facts = state[group] ?? []; if (!Array.isArray(facts) || facts.length > 64) throw new Error("任务摘要条目过多");
    for (const value of facts) {
      const fact = object(value); fields(fact, ["text", "source_event_ids"]); const valueText = text(fact, "text"), ids = fact.source_event_ids;
      if (!valueText.trim() || Array.from(valueText).length > 512 || TASK_CREDENTIAL.test(valueText) || !Array.isArray(ids) || !ids.length || ids.length > 16 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "number" || !Number.isSafeInteger(id) || !allowed.has(id))) throw new Error("任务摘要来源或内容无效");
    }
  }
  return state;
}
