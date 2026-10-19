import type { Resource, ResourceTreeNode } from "../../shared/contracts";

export function projectResourceTree(projectId: string, nodes: ResourceTreeNode[], resources: Resource[]): ResourceTreeNode[] {
  const locals = new Set(resources.filter(resource => resource.projectId === projectId && resource.kind === "local").map(resource => resource.id));
  const tree = nodes.filter(node => node.projectId === projectId).map(node => locals.has(node.resourceId ?? "") ? {...node, parentId: null, position: -1, builtin: true} : node);
  const indexed = new Set(tree.filter(node => node.kind === "resource").map(node => node.resourceId));
  let position = Math.max(-1, ...tree.filter(node => !node.parentId).map(node => node.position)) + 1;
  return [...tree, ...resources.filter(resource => resource.projectId === projectId && !indexed.has(resource.id)).map(resource => ({id: resource.id, projectId, parentId: null, kind: "resource" as const, name: "", resourceId: resource.id, position: resource.kind === "local" ? -1 : position++, builtin: resource.kind === "local"}))];
}

export function treeChildren(nodes: ResourceTreeNode[], parent: string | null): ResourceTreeNode[] {
  return nodes.filter(node => node.parentId === parent).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

export function canMoveInto(nodes: ResourceTreeNode[], source: string, parent: string | null): boolean {
  const map = new Map(nodes.map(node => [node.id, node]));
  if (map.get(source)?.builtin) return false;
  const seen = new Set<string>();
  while (parent) {
    const node = map.get(parent);
    if (!node || node.kind !== "folder" || source === parent || seen.has(parent)) return false;
    seen.add(parent); parent = node.parentId;
  }
  return map.has(source);
}

export function dropPlacement(nodes: ResourceTreeNode[], target: ResourceTreeNode, zone: "before" | "inside" | "after") {
  if (target.builtin) return {parentId: null, beforeId: treeChildren(nodes, null).find(node => !node.builtin)?.id ?? null};
  if (zone === "inside" && target.kind === "folder") return {parentId: target.id, beforeId: null};
  const siblings = treeChildren(nodes, target.parentId);
  const next = siblings[siblings.findIndex(node => node.id === target.id) + 1];
  return {parentId: target.parentId, beforeId: zone === "before" ? target.id : next?.id ?? null};
}
