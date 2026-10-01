import type { JsonValue } from "./json.js";
import { object, text, type Params } from "./validation.js";
import { resolveValue } from "./workflow.js";

export const terminalNode = (status: string): boolean => ["completed", "failed", "unknown", "skipped", "cancelled"].includes(status);
export function dependencyDecision(node: Params, statuses: Map<string, string>): { ready: boolean; run: boolean } {
  const dependencies = node.depends_on as string[] | undefined ?? [];
  if (!dependencies.length) return { ready: true, run: true };
  const values = dependencies.map(id => statuses.get(id) ?? "pending");
  return { ready: values.every(terminalNode), run: node.when === "always" || (node.when === "any_failure" ? values.some(value => value === "failed" || value === "unknown") : values.every(value => value === "completed")) };
}
export function workflowCalls(node: Params, results: Map<string, JsonValue>): Params[] {
  const each = object(node.for_each), source = each.ref ? resolveValue({ type: "array", ref: each.ref }, results) : [null];
  if (!Array.isArray(source) || source.length > Number(each.max_items ?? 1)) throw new Error("工作流扇出数量或类型无效");
  return source.map(item => {
    if (each.element_type && (Array.isArray(item) ? "array" : typeof item) !== each.element_type) throw new Error("扇出元素类型无效");
    const call: Params = {};
    for (const field of ["target", "command", "request"]) if (node[field]) call[field] = resolveValue(object(node[field]), results, item ?? undefined);
    const inputs: Params = {}; for (const [key, value] of Object.entries(object(node.inputs))) inputs[key] = resolveValue(object(value), results, item ?? undefined);
    if (node.kind === "tool_call") call.inputs = inputs;
    if (call.target && (text(call, "target").includes("/") || text(call, "target").startsWith("$"))) throw new Error("工作流目标必须是当前湖的确定资源");
    return call;
  });
}
export function validWorkflowResult(node: Params, result: JsonValue): boolean {
  const kind = node.for_each ? "array" : node.kind === "tool_call" ? text(node, "output_type") : "object";
  return result !== null && (Array.isArray(result) ? "array" : typeof result) === kind && new TextEncoder().encode(JSON.stringify(result)).length <= 65536;
}
export function bindWorkflow(spec: Params, p: Params): Params {
  const copy = object(JSON.parse(JSON.stringify(spec)) as JsonValue), mode = text(copy, "target_mode", "fixed"), bindings = object(p.bindings);
  const targets = mode === "multiple" ? p.targets : mode === "single" ? [text(p, "resource")] : [""];
  if (!Array.isArray(targets) || !targets.length || targets.length > 32 || targets.some(target => typeof target !== "string" || (mode !== "fixed" && (!target || target.includes("/"))))) throw new Error("工作流目标选择无效");
  const steps = copy.steps as Params[], expanded: Params[] = [];
  for (const [index, target] of targets.entries()) for (const step of steps) {
    const prefix = mode === "multiple" ? `target${index}_` : "", resource = text(step, "resource"), resolved = resource.startsWith("$") ? text(bindings, resource, String(target)) : resource;
    if (!resolved || resolved.startsWith("$") || resolved.includes("/")) throw new Error("工作流存在未绑定的资源");
    expanded.push({ ...step, id: prefix + text(step, "id"), resource: resolved, depends_on: (step.depends_on as string[] | undefined ?? []).map(dep => prefix + dep) });
  }
  if (expanded.length > 32) throw new Error("工作流展开步骤超过 32");
  return { ...copy, target_mode: "fixed", steps: expanded };
}
