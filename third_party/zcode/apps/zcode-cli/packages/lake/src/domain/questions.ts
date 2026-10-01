import type { JsonValue } from "./json.js";
import { fields } from "./presentation-json.js";
import { object, redact, text, type Params } from "./validation.js";

const ID = /^[a-z][a-z0-9_]{0,63}$/u;
function questionText(value: string, limit: number, optional = false): void {
  if ((!optional && !value.trim()) || value.includes("\0") || Array.from(value).length > limit || redact(value, 16384) !== value || /api_key=|api-key:|bearer\s/iu.test(value)) throw new Error("问题或回答无效、过长或包含凭据");
}
export function checkedQuestions(value: JsonValue): Params[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error("每次需要 1 至 3 个问题");
  const ids = new Set<string>();
  return value.map(value => {
    const question = object(value); fields(question, ["id", "header", "prompt", "options"]); const id = text(question, "id"), options = question.options ?? [];
    if (!ID.test(id) || ids.has(id) || !Array.isArray(options) || (options.length && (options.length < 2 || options.length > 3))) throw new Error("问题标识或选项数量无效"); ids.add(id);
    questionText(text(question, "header"), 48); questionText(text(question, "prompt"), 1200);
    const labels = new Set<string>();
    for (const value of options) { const option = object(value); fields(option, ["label", "description"]); const label = text(option, "label"); questionText(label, 120); questionText(text(option, "description"), 512, true); if (labels.has(label)) throw new Error("问题选项重复"); labels.add(label); }
    return question;
  });
}
export function checkedAnswers(value: JsonValue, questions?: Params[]): Params {
  const answers = object(value), ids = Object.keys(answers);
  if (ids.length < 1 || ids.length > 3 || (questions && (ids.length !== questions.length || questions.some(question => !ids.includes(text(question, "id")))))) throw new Error("请回答本次全部问题");
  for (const id of ids) { if (!ID.test(id)) throw new Error("回答标识无效"); questionText(text(answers, id), 2048); }
  return answers;
}
