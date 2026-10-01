import type { JsonValue } from "./json.js";
import { command, FIXED_READ_CHECKS, integer, name, object, text, type Params } from "./validation.js";

export function graphOrder(nodes: Params[]): Params[] {
  const byID = new Map<string, Params>(), visited = new Set<string>(), visiting = new Set<string>(), result: Params[] = [];
  for (const node of nodes) {
    const id = text(node, "id");
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(id) || byID.has(id)) throw new Error("工作流节点 ID 无效或重复");
    byID.set(id, node);
  }
  const visit = (id: string) => {
    if (visited.has(id)) return;
    const node = byID.get(id);
    if (!node || visiting.has(id)) throw new Error("工作流依赖缺失或存在环");
    visiting.add(id);
    const deps = node.depends_on ?? [];
    if (!Array.isArray(deps) || new Set(deps).size !== deps.length) throw new Error("工作流依赖无效");
    for (const dep of deps) { if (typeof dep !== "string" || dep === id) throw new Error("工作流依赖无效"); visit(dep); }
    visiting.delete(id); visited.add(id); result.push(node);
  };
  for (const id of byID.keys()) visit(id);
  return result;
}
export function validateWorkflow(spec: Params, version: number): Params[] {
  name(text(spec, "name"));
  if (text(spec, "description").length > 2000) throw new Error("工作流描述过长");
  const items = spec[version === 2 ? "nodes" : "steps"];
  if (!Array.isArray(items) || !items.length || items.length > 32) throw new Error("工作流节点数量无效");
  if (version === 2 && spec.version !== 2) throw new Error("工作流版本必须为 2");
  if (version === 1 && !["", "adaptive", "fixed"].includes(text(spec, "execution_mode"))) throw new Error("无效的工作流执行模式");
  if (version === 1 && !["", "fixed", "single", "multiple"].includes(text(spec, "target_mode"))) throw new Error("无效的工作流目标模式");
  const nodes = items.map(object), ordered = graphOrder(nodes);
  let expanded = 0;
  const parallel = integer(spec, "max_parallel", 4) || 4;
  if (version === 2 && (parallel < 1 || parallel > 4)) throw new Error("最大并行数必须为 1–4");
  for (const node of nodes) {
    const kind = text(node, "kind");
    if (!["", "all_success", "any_failure", "always"].includes(text(node, "when"))) throw new Error("无效的工作流条件");
    if (version === 1) {
      name(text(node, "name")); const resource = text(node, "resource");
      if (!resource || resource.includes("/") || (spec.target_mode === "fixed" && resource.startsWith("$"))) throw new Error("无效的工作流资源");
      const timeout = integer(node, "timeout_seconds");
      if (timeout < 0 || timeout > 3600) throw new Error("工作流超时无效");
      if (kind === "ssh_check") { if (!FIXED_READ_CHECKS[text(node, "check")] || node.command) throw new Error("无效的工作流检查"); }
      else if (kind === "ssh_command") { command(text(node, "command")); if (node.check) throw new Error("命令步骤不能指定检查"); }
      else if (kind === "ssh_task") { if (!text(node, "goal") || node.command || node.check || spec.execution_mode === "fixed") throw new Error("目标任务步骤无效"); }
      else throw new Error("未知的工作流步骤类型");
    } else {
      if (!["ssh_check", "ssh_command", "code_task", "specialist_task", "tool_call"].includes(kind)) throw new Error("未知的工作流节点类型");
      const each = object(node.for_each), maximum = integer(each, "max_items", 1);
      if (node.for_each && (maximum < 1 || maximum > 32 || !each.ref)) throw new Error("扇出配置无效");
      expanded += maximum;
      if (expanded > 32) throw new Error("工作流展开节点超过 32");
      if (node.target) validateValue(object(node.target));
      if (node.command) validateValue(object(node.command));
      if (node.request) validateValue(object(node.request));
      for (const value of Object.values(object(node.inputs))) validateValue(object(value));
      if (kind === "ssh_check" && !FIXED_READ_CHECKS[text(node, "check")]) throw new Error("无效的工作流检查");
      if (kind === "ssh_command" && (!node.target || !node.command)) throw new Error("命令节点缺少 target 或 command");
      if (kind === "ssh_check" && !node.target) throw new Error("检查节点缺少 target");
      if (["code_task", "specialist_task"].includes(kind) && !node.request) throw new Error("专员节点缺少 request");
      if (kind === "specialist_task" && !/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(text(node, "specialist"))) throw new Error("专员名称无效");
      if (kind === "tool_call" && (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(text(node, "tool")) || !["string", "number", "boolean", "object", "array"].includes(text(node, "output_type")))) throw new Error("工具节点无效");
      for (const value of [node.target, node.command, node.request, ...Object.values(object(node.inputs))]) {
        const reference = object(object(value).ref);
        if (reference.node && !(node.depends_on as JsonValue[] | undefined ?? []).includes(reference.node)) throw new Error("工作流只能引用直接依赖节点的结果");
        if (object(value).item && !node.for_each) throw new Error("循环项只能在扇出节点中使用");
      }
    }
  }
  return ordered;
}
export function validateValue(value: Params): void {
  const kind = text(value, "type");
  if (!["string", "number", "boolean", "object", "array"].includes(kind)) throw new Error("工作流值类型无效");
  const reference = object(value.ref), sources = Number("literal" in value) + Number(!!value.ref) + Number(value.item === true);
  if (sources !== 1) throw new Error("工作流值必须有唯一来源");
  if (value.ref && (!text(reference, "node") || text(reference, "type") !== kind || (text(reference, "path") && !text(reference, "path").startsWith("/")))) throw new Error("工作流结果引用无效");
  if ("literal" in value) assertValueType(value.literal, kind);
}
function assertValueType(value: JsonValue, kind: string): void {
  const actual = Array.isArray(value) ? "array" : typeof value;
  if (value === null || actual !== kind) throw new Error("工作流值与声明类型不匹配");
}
export function resolveValue(value: Params, results: Map<string, JsonValue>, item?: JsonValue): JsonValue {
  validateValue(value);
  let resolved: JsonValue;
  if (value.item === true) { if (item === undefined) throw new Error("不在循环中"); resolved = item; }
  else if (value.ref) {
    const reference = object(value.ref);
    if (!results.has(text(reference, "node"))) throw new Error("被引用的节点尚未完成");
    resolved = results.get(text(reference, "node")) as JsonValue;
    for (const key of text(reference, "path").split("/").slice(1).map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
      if (["__proto__", "constructor", "prototype"].includes(key) || resolved === null || typeof resolved !== "object" || !Object.hasOwn(resolved, key) || (Array.isArray(resolved) && !/^(?:0|[1-9][0-9]*)$/u.test(key))) throw new Error("结果引用路径不存在");
      resolved = Array.isArray(resolved) ? resolved[Number(key)] : resolved[key];
    }
  } else resolved = value.literal;
  assertValueType(resolved, text(value, "type")); return resolved;
}
export const V2_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  pending: ["waiting_approval", "running", "skipped", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "pending", "cancelled"],
  running: ["completed", "failed", "unknown", "cancelled"],
  failed: ["pending"], unknown: ["pending"], cancelled: ["pending"], skipped: ["pending"], completed: [],
};
