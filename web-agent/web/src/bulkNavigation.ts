import type { Catalog } from "../../shared/contracts";

export type BulkTarget = { kind: "session" | "resource" | "folder" | "project"; id: string; projectId: string; name: string; projectName?: string };
export const bulkKey = (target: BulkTarget) => `${target.kind}:${target.id}`;
export const bulkKindLabel = (kind: BulkTarget["kind"]) => ({session: "会话", resource: "资源", folder: "文件夹", project: "项目"})[kind];

export function bulkCatalogTargets(catalog: Catalog): BulkTarget[] {
  return [
    ...catalog.projects.map(p => ({kind: "project" as const, id: p.id, projectId: p.id, name: p.name})),
    ...catalog.sessions.map(s => ({kind: "session" as const, id: s.id, projectId: s.projectId, name: s.title})),
    ...catalog.resources.filter(r => r.kind !== "local").map(r => ({kind: "resource" as const, id: r.id, projectId: r.projectId, name: r.name})),
    ...(catalog.resourceTree ?? []).filter(n => n.kind === "folder").map(n => ({kind: "folder" as const, id: n.id, projectId: n.projectId, name: n.name})),
  ];
}

/** A selected project covers its children without permanently deleting their sessions. */
export function addBulkTargets(selected: BulkTarget[], added: BulkTarget[]): BulkTarget[] {
  let next = [...selected];
  for (const target of added) {
    next = next.filter(item => bulkKey(item) !== bulkKey(target) && !(target.kind === "project" ? item.projectId === target.id : item.kind === "project" && item.id === target.projectId));
    next.push(target);
  }
  return next;
}

export function orderBulkDeletion(targets: BulkTarget[], catalog: Catalog): BulkTarget[] {
  const nodes = new Map((catalog.resourceTree ?? []).map(node => [node.id, node]));
  const depth = (id: string) => {
    let count = 0, parent = nodes.get(id)?.parentId;
    const seen = new Set([id]);
    while (parent && !seen.has(parent)) { seen.add(parent); count++; parent = nodes.get(parent)?.parentId; }
    return count;
  };
  const rank = {session: 0, resource: 1, folder: 2, project: 3};
  const locals = new Set(catalog.resources.filter(resource => resource.kind === "local").map(resource => resource.id));
  return targets.filter(target => target.kind !== "resource" || !locals.has(target.id)).sort((a, b) => rank[a.kind] - rank[b.kind] || (a.kind === "folder" ? depth(b.id) - depth(a.id) : 0)).map(target => ({...target, projectName: catalog.projects.find(project => project.id === target.projectId)?.name}));
}

export type BulkDeleteResult = { removed: BulkTarget[]; failed: {target: BulkTarget; message: string}[] };
export async function deleteBulkTargets(targets: BulkTarget[], remove: (target: BulkTarget) => Promise<unknown>, errorMessage: (error: unknown) => string): Promise<BulkDeleteResult> {
  const result: BulkDeleteResult = {removed: [], failed: []};
  for (const [index, target] of targets.entries()) {
    try { await remove(target); result.removed.push(target); }
    catch (error) {
      result.failed.push({target, message: errorMessage(error)});
      if ((error as {status?: number})?.status === 401) {
        result.failed.push(...targets.slice(index + 1).map(target => ({target, message: "未处理：访问会话已失效，请重新连接后重试。"})));
        break;
      }
    }
  }
  return result;
}
