import type { Resource, ResourceTreeNode } from "../../shared/contracts";

/** Keep matched resources in their original folders without exposing empty unrelated branches. */
export function resourceSearchNodes(projectId: string, nodes: ResourceTreeNode[], resources: Resource[]): ResourceTreeNode[] {
  const projectNodes = nodes.filter(node => node.projectId === projectId);
  const nodeMap = new Map(projectNodes.map(node => [node.id, node]));
  const resourceIds = new Set(resources.filter(resource => resource.projectId === projectId).map(resource => resource.id));
  const visible = new Set<string>();
  for (const node of projectNodes) {
    if (node.kind !== "resource" || !node.resourceId || !resourceIds.has(node.resourceId)) continue;
    let current: ResourceTreeNode | undefined = node;
    while (current && !visible.has(current.id)) {
      visible.add(current.id);
      current = current.parentId ? nodeMap.get(current.parentId) : undefined;
    }
  }
  return projectNodes.filter(node => visible.has(node.id));
}
