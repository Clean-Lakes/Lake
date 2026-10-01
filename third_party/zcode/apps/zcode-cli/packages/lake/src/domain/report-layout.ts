import { fields } from "./presentation-json.js";
import { integer, object, text, type Params } from "./validation.js";

export function validateReportLayout(ui: Params, report: Params): void {
  fields(ui, ["root", "elements"]);
  const elements = object(ui.elements), root = text(ui, "root"), ids = Object.keys(elements), parents = new Map<string, number>(), coverage = new Map<string, Set<number>>();
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(root) || !elements[root] || !ids.length || ids.length > 64) throw new Error("动态报告布局无效");
  let table = false, flow = false;
  for (const id of ids) {
    const element = object(elements[id]), props = object(element.props), type = text(element, "type"), children = element.children ?? [], labels = props.labels ?? [];
    fields(element, ["type", "props", "children"]); fields(props, ["title", "columns", "index", "labels"]);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(id) || !Array.isArray(children) || children.length > 16 || !Array.isArray(labels) || labels.length > 6 || labels.some(label => typeof label !== "string" || !label.trim() || Array.from(label).length > 40) || Array.from(text(props, "title")).length > 80) throw new Error("动态报告组件无效");
    const columns = integer(props, "columns"), index = props.index === undefined ? undefined : integer(props, "index"), title = text(props, "title");
    let container = false;
    if (["Stack", "Grid", "Card", "Accordion", "Tabs"].includes(type)) {
      container = true;
      if (index !== undefined || !children.length) throw new Error("报告容器无效");
      if (type === "Stack" && (title || columns || labels.length)) throw new Error("Stack 参数无效");
      if (type === "Grid" && (columns < 1 || columns > 4 || title || labels.length)) throw new Error("Grid 参数无效");
      if (["Card", "Accordion"].includes(type) && (!title.trim() || columns || labels.length)) throw new Error("Card 参数无效");
      if (type === "Tabs" && (labels.length < 2 || labels.length !== children.length || title || columns)) throw new Error("Tabs 参数无效");
    } else if (["Metric", "Chart", "Finding"].includes(type)) {
      const group = ({ Metric: "metrics", Chart: "charts", Finding: "findings" } as Record<string, string>)[type], items = report[group] ?? [];
      if (index === undefined || index < 0 || !Array.isArray(items) || index >= items.length || title || columns || labels.length) throw new Error("报告数据索引无效");
      if (!coverage.has(group)) coverage.set(group, new Set()); coverage.get(group)?.add(index);
    } else if (type === "Table" || type === "Flow") {
      if (index !== undefined || title || columns || labels.length || !report[type.toLowerCase()]) throw new Error("报告数据无效");
      if (type === "Table") table = true; else flow = true;
    } else throw new Error("未知的报告组件");
    if (!container && children.length) throw new Error("数据组件不能有子组件");
    for (const child of children) { if (typeof child !== "string" || !elements[child]) throw new Error("报告子组件不存在"); const count = (parents.get(child) ?? 0) + 1; if (count > 1) throw new Error("报告组件重复引用"); parents.set(child, count); }
  }
  if (parents.has(root)) throw new Error("报告根组件不能有父组件");
  const seen = new Set<string>();
  const visit = (id: string, depth: number): void => { if (depth > 8 || seen.has(id)) throw new Error("报告布局循环或超过 8 层"); seen.add(id); for (const child of object(elements[id]).children as string[] | undefined ?? []) visit(child, depth + 1); };
  visit(root, 1); if (seen.size !== ids.length) throw new Error("报告布局包含不可达组件");
  for (const group of ["metrics", "charts", "findings"]) if ((coverage.get(group)?.size ?? 0) !== (report[group] as unknown[] | undefined ?? []).length) throw new Error("动态界面必须包含全部数据和异常提示");
  if ((report.table && !table) || (report.flow && !flow)) throw new Error("动态界面遗漏数据");
}
