import type { JsonValue } from "./json.js";
import { cleanJSON, fields } from "./presentation-json.js";
import { object, text, type Params } from "./validation.js";
import { validateReportLayout } from "./report-layout.js";

const TONES = ["good", "warning", "critical", "info", "unknown"];
function reportText(p: Params, key: string, max: number, required = false): void {
  const value = text(p, key); if (value.includes("\0") || Array.from(value).length > max || (required && !value.trim())) throw new Error("报告文字无效或过长");
}
function tone(p: Params): void { if (!TONES.includes(text(p, "tone"))) throw new Error("报告状态无效"); }
function array(p: Params, key: string, limit: number, required = false): JsonValue[] {
  const value = p[key] ?? []; if (!Array.isArray(value) || value.length > limit || (required && !value.length)) throw new Error("报告列表数量无效"); return value;
}
export function sanitizeReport(input: JsonValue): Params {
  const report = object(JSON.parse(JSON.stringify(input)) as JsonValue);
  fields(report, ["title", "summary", "tone", "scope", "metrics", "charts", "table", "findings", "flow", "sources", "ui"]);
  if (new TextEncoder().encode(JSON.stringify(report)).length > 48 * 1024) throw new Error("报告超过 48 KiB");
  reportText(report, "title", 80, true); reportText(report, "summary", 280, true); reportText(report, "scope", 200); tone(report);
  const metrics = array(report, "metrics", 8), charts = array(report, "charts", 3), findings = array(report, "findings", 8);
  if (!metrics.length && !charts.length && !findings.length && !report.table && !report.flow) throw new Error("报告至少包含一项实际数据");
  for (const value of metrics) { const item = object(value); fields(item, ["label", "value", "hint", "tone"]); reportText(item, "label", 40, true); reportText(item, "value", 40, true); reportText(item, "hint", 100); tone(item); }
  for (const value of charts) {
    const chart = object(value); fields(chart, ["title", "kind", "unit", "segments"]); reportText(chart, "title", 80, true); reportText(chart, "unit", 20);
    if (!["distribution", "bar"].includes(text(chart, "kind"))) throw new Error("报告图表类型无效"); let total = 0;
    for (const value of array(chart, "segments", 16, true)) {
      const item = object(value); fields(item, ["label", "value", "tone"]); reportText(item, "label", 60, true); tone(item);
      if (typeof item.value !== "number" || !Number.isFinite(item.value) || item.value < 0 || item.value > 1e12) throw new Error("图表数值无效"); total += item.value;
    }
    if (chart.kind === "distribution" && !total) throw new Error("占比图至少需要一个非零数值");
  }
  if (report.table) {
    const table = object(report.table); fields(table, ["title", "columns", "rows"]); reportText(table, "title", 80, true);
    const columns = array(table, "columns", 6, true); for (const column of columns) reportText({ value: column }, "value", 40, true);
    for (const value of array(table, "rows", 100)) { const row = object(value); fields(row, ["cells", "tone"]); tone(row); const cells = array(row, "cells", 6); if (cells.length !== columns.length) throw new Error("表格列数不一致"); cells.forEach(value => reportText({ value }, "value", 240)); }
  }
  for (const value of findings) { const item = object(value); fields(item, ["title", "detail", "next_step", "tone"]); tone(item); reportText(item, "title", 80, true); reportText(item, "detail", 500, true); reportText(item, "next_step", 200); }
  for (const value of array(report, "sources", 8)) reportText({ value }, "value", 300, true);
  if (report.flow) {
    const flow = object(report.flow); fields(flow, ["nodes", "edges"]); const nodes = array(flow, "nodes", 64, true).map(object), edges = array(flow, "edges", 128).map(object), ids = new Map<string, string>();
    for (const [index, node] of nodes.entries()) { fields(node, ["id", "label", "status", "detail"]); reportText(node, "id", 128, true); reportText(node, "label", 80, true); reportText(node, "detail", 500); const id = text(node, "id"); if (ids.has(id) || !["pending", "running", "completed", "failed", "unknown", "skipped", "cancelled"].includes(text(node, "status"))) throw new Error("流程节点无效"); ids.set(id, `node-${index + 1}`); }
    const seen = new Set<string>(), visiting = new Set<string>();
    for (const edge of edges) { fields(edge, ["from", "to"]); if (!ids.has(text(edge, "from")) || !ids.has(text(edge, "to"))) throw new Error("流程节点引用不存在"); }
    const visit = (id: string): void => { if (visiting.has(id)) throw new Error("流程图不能包含循环"); if (seen.has(id)) return; visiting.add(id); for (const edge of edges.filter(edge => edge.from === id)) visit(text(edge, "to")); visiting.delete(id); seen.add(id); };
    for (const id of ids.keys()) visit(id);
    for (const node of nodes) node.id = ids.get(text(node, "id")) as string;
    for (const edge of edges) { edge.from = ids.get(text(edge, "from")) as string; edge.to = ids.get(text(edge, "to")) as string; }
  }
  if (report.ui) {
    const ui = object(report.ui); validateReportLayout(ui, report); const elements = object(ui.elements), ids = new Map(Object.keys(elements).sort().map((id, index) => [id, `element-${index + 1}`]));
    ui.root = ids.get(text(ui, "root")) as string;
    ui.elements = Object.fromEntries(Object.entries(elements).map(([id, value]) => { const element = object(value); if (element.children) element.children = (element.children as string[]).map(child => ids.get(child) as string); return [ids.get(id) as string, element]; }));
  }
  return object(cleanJSON(report));
}
