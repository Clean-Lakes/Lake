import type { Resource, ResourceTreeNode } from "../../shared/contracts";

export function projectResourceTree(projectId: string, nodes: ResourceTreeNode[], resources: Resource[]): ResourceTreeNode[] {
  const locals = new Set(resources.filter(resource => resource.projectId === projectId && resource.kind === "local").map(resource => resource.id));
  const tree = nodes.filter(node => node.projectId === projectId).map(node => locals.has(node.resourceId ?? "") ? {...node, parentId: null, position: -1, builtin: true} : node);
  const indexed = new Set(tree.filter(node => node.kind === "resource").map(node => node.resourceId));
  let position = Math.max(-1, ...tree.filter(node => !node.parentId).map(node => node.position)) + 1;
  return [...tree, ...resources.filter(resource => resource.projectId === projectId && !indexed.has(resource.id)).map(resource => ({id: resource.id, projectId, parentId: null, kind: "resource" as const, name: "", resourceId: resource.id, position: resource.kind === "local" ? -1 : position++, builtin: resource.kind === "local"}))];
}

export function treeChildren(nodes: ResourceTreeNode[], parent: string | null): ResourceTreeNode[] {
  return nodes.filter(node => node.parentId === parent).sort(compareTreeNodes);
}

export function compareTreeNodes(a: ResourceTreeNode,b: ResourceTreeNode): number {
  const rank=(node:ResourceTreeNode)=>node.builtin?-1:node.kind==='folder'?0:1;
  return rank(a)-rank(b)||a.position-b.position||a.id.localeCompare(b.id);
}

// Vertical movement sorts siblings; move right over a folder's middle to nest.
export function treeDropZone(target:ResourceTreeNode,ratio:number,offsetX:number):'before'|'inside'|'after' {
  if(target.kind==='folder'&&offsetX>=48&&ratio>=.25&&ratio<=.75)return 'inside';
  return ratio<.5?'before':'after';
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

export function dropPlacement(nodes: ResourceTreeNode[], target: ResourceTreeNode, zone: "before" | "inside" | "after",sourceId?:string) {
  const source=nodes.find(node=>node.id===sourceId);
  const siblings=treeChildren(nodes,target.parentId).filter(node=>node.id!==sourceId&&!node.builtin);
  if (target.builtin) return {parentId: null, beforeId: siblings.find(node=>!source||node.kind===source.kind)?.id ?? null};
  if (zone === "inside" && target.kind === "folder") return {parentId: target.id, beforeId: null};
  if(source&&source.kind!==target.kind)return {parentId:target.parentId,beforeId:siblings.find(node=>node.kind==='resource')?.id??null};
  const next = siblings[siblings.findIndex(node => node.id === target.id) + 1];
  return {parentId: target.parentId, beforeId: zone === "before" ? target.id : next?.id ?? null};
}
