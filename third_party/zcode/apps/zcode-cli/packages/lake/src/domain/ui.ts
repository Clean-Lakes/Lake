import type { JsonValue } from "./json.js";
import { boundedJSON, boundValue, cleanJSON, fields, pointer } from "./presentation-json.js";
import { integer, object, redact, text, type Params } from "./validation.js";

export const UI_CATALOG = "com.cleanlakes.lake:catalog-v1", UI_VERSION = "v0.9.1";
const IDENTIFIER = /^[A-Za-z0-9_-]{1,96}$/u;
const UI_FIELDS: Record<string, string[]> = {
  Column: ["children"], Row: ["children"], Card: ["children", "title"], Tabs: ["children", "labels", "active"], Text: ["text", "variant"], Markdown: ["text"], Code: ["text", "label", "language"], List: ["label", "items", "ordered", "start"], Metric: ["label", "value"], Chart: ["label", "values", "unit", "max"], Button: ["label", "action"], ChoicePicker: ["label", "value", "options"], TextField: ["label", "value"], Table: ["columns", "headers", "rows", "action", "label"], Log: ["text", "label"],
};
const REQUIRED: Record<string, string[]> = {
  Column: ["children"], Row: ["children"], Card: ["children", "title"], Tabs: ["children", "labels"], Text: ["text"], Markdown: ["text"], Code: ["text"], List: ["items"], Metric: ["label", "value"], Chart: ["label", "values"], Button: ["label", "action"], ChoicePicker: ["label", "value", "options"], TextField: ["label", "value"], Table: ["columns", "rows"], Log: ["text"],
};
function action(value: JsonValue, kind: string): void {
  const wrapper = object(value); fields(wrapper, ["event"]); const event = object(wrapper.event); fields(event, ["name", "context"]);
  const name = text(event, "name");
  if (name !== "continue" && !(kind === "ports" && ["inspect_ports", "inspect_process"].includes(name))) throw new Error("未知的界面操作");
  const context = object(event.context);
  if (Object.keys(context).length > 8) throw new Error("界面动作上下文超过 8 个字段");
  for (const value of Object.values(context)) {
    if (value === null || Array.isArray(value)) throw new Error("动作上下文只能使用简单值");
    if (typeof value === "object") { fields(value, ["path"]); pointer(text(value, "path")); }
  }
}
function validateBindings(component: Params, data: Params): void {
  for (const key of ["text", "value", "label", "title", "unit", "active", "rows", "options", "values", "items"]) {
    const raw = component[key]; if (raw === undefined) continue;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) { fields(raw, ["path"]); pointer(text(raw, "path")); }
    const value = boundValue(raw, data); if (value === undefined) continue;
    if (["text", "value", "label", "title", "unit"].includes(key)) { if (typeof value !== "string") throw new Error("界面文字必须为字符串或路径绑定"); }
    else if (key === "active") { const labels = component.labels as JsonValue[]; if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= labels.length) throw new Error("标签索引无效"); }
    else {
      if (!Array.isArray(value)) throw new Error("界面列表必须为数组或路径绑定");
      if (key === "values" && value.length > 16) throw new Error("图表最多 16 个数值");
      for (const item of value) {
        if (key === "items") { if (typeof item !== "string") throw new Error("清单项必须是文字"); continue; }
        const row = object(item);
        if (key === "rows") { if (Object.values(row).some(cell => cell && typeof cell === "object")) throw new Error("表格单元格只能使用简单值"); }
        else if (key === "options") { if (typeof row.label !== "string" || typeof row.value !== "string") throw new Error("选项缺少 label/value"); }
        else if (!text(row, "label") || typeof row.value !== "number" || row.value < 0 || (typeof component.max === "number" && row.value > component.max)) throw new Error("图表数值无效");
      }
    }
  }
}
export function sanitizeSnapshot(input: JsonValue): Params {
  const snapshot = object(JSON.parse(JSON.stringify(input)) as JsonValue);
  fields(snapshot, ["surfaceId", "catalogId", "revision", "kind", "components", "data", "deleted"]);
  if (!IDENTIFIER.test(text(snapshot, "surfaceId")) || snapshot.catalogId !== UI_CATALOG || !["", "ports"].includes(text(snapshot, "kind")) || integer(snapshot, "revision") < 0 || new TextEncoder().encode(JSON.stringify(snapshot)).length > 48 * 1024) throw new Error("面板标识或大小无效");
  if (snapshot.deleted === true) return snapshot;
  if (!Array.isArray(snapshot.components) || snapshot.components.length > 64 || !snapshot.data) throw new Error("面板数据或组件数量无效");
  const data = object(snapshot.data); boundedJSON(data); const nodes = new Map<string, Params>(), edges = new Map<string, string[]>();
  for (const value of snapshot.components) {
    const component = object(value), id = text(component, "id"), type = text(component, "component"), allowed = UI_FIELDS[type];
    if (!allowed || !IDENTIFIER.test(id) || nodes.has(id) || redact(id, 96) !== id) throw new Error("未知组件或重复/敏感 ID");
    fields(component, ["id", "component", ...allowed]); boundedJSON(component); nodes.set(id, component);
    for (const key of REQUIRED[type] ?? []) if (component[key] === undefined || component[key] === null) throw new Error("界面组件缺少必需字段");
    for (const [key, value] of Object.entries(component)) {
      if (["children", "labels", "columns", "headers"].includes(key)) {
        if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== "string")) throw new Error("界面列表字段无效");
        if (key === "children") edges.set(id, value as string[]);
      }
      if (key === "action") action(value, text(snapshot, "kind"));
      if (key === "ordered" && typeof value !== "boolean") throw new Error("ordered 必须为布尔值");
      if (key === "language" && (typeof value !== "string" || value.length > 80)) throw new Error("代码语言无效");
      if (["max", "start"].includes(key) && (typeof value !== "number" || value <= 0 || value > 1e12 || (key === "start" && (!Number.isInteger(value) || value > 1_000_000)))) throw new Error("范围或起始编号无效");
    }
    if (type === "Tabs") { const count = (edges.get(id) ?? []).length; if (count < 1 || count > 6 || count !== (component.labels as JsonValue[]).length) throw new Error("标签与子组件数不匹配"); }
    if (type === "Table") { const count = (component.columns as JsonValue[]).length; if (count < 1 || count > 12 || (component.headers && (component.headers as JsonValue[]).length !== count)) throw new Error("表格列数无效"); }
    validateBindings(component, data);
  }
  if (nodes.size && !nodes.has("root")) throw new Error("面板须有 root 根组件");
  const checkTree = (start: string): Set<string> => {
    const seen = new Set<string>();
    const visit = (id: string, depth: number): void => { if (depth > 8 || seen.has(id) || !nodes.has(id)) throw new Error("组件循环、重复引用或不存在"); seen.add(id); for (const child of edges.get(id) ?? []) visit(child, depth + 1); };
    visit(start, 1); return seen;
  };
  if (nodes.size) { const reached = checkTree("root"); for (const id of nodes.keys()) if (!reached.has(id)) checkTree(id); }
  if (redact(text(snapshot, "surfaceId"), 96) !== snapshot.surfaceId) throw new Error("面板 ID 包含敏感内容");
  return object(cleanJSON(snapshot));
}
