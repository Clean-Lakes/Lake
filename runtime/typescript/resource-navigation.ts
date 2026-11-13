import type {NavigationTrashItem, Resource, ResourceTreeNode} from '../../web-agent/shared/contracts';
import {HttpError, id, LakeStore, now} from './store';

const trashKey = (kind: string, key: string) => `${kind}:${key}`;
export const hiddenItem = (store: LakeStore, kind: string, key: string) =>
  store.list<NavigationTrashItem>('navigationTrash').some(item => item.kind === kind && item.id === key);
const name = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 120 || /[\0\r\n]/.test(value)) throw new HttpError(400, '目录名称须为 1 至 120 个字符');
  return value.trim();
};

export class LakeResourceNavigation {
  constructor(readonly store: LakeStore, readonly busy: (projectId: string,actorSessionId?:string) => boolean) {}
  private nodes(projectId: string) { this.store.project(projectId); return this.store.catalog().resourceTree!.filter(node => node.projectId === projectId); }
  parent(projectId: string, parentId: unknown) {
    if (parentId == null) return null;
    if (typeof parentId !== 'string') throw new HttpError(400, '父目录身份无效');
    const nodes = this.nodes(projectId), seen = new Set<string>(); let cursor: string | null = parentId;
    while (cursor) {
      if (seen.has(cursor) || seen.size >= 32) throw new HttpError(409, '资源目录包含循环或超过 32 层');
      seen.add(cursor); const node = nodes.find(node => node.id === cursor);
      if (!node || node.kind !== 'folder') throw new HttpError(404, '父目录不属于当前项目');
      cursor = node.parentId;
    }
    return parentId;
  }
  attach(resource: Resource, parent: unknown) {
    const parentId = this.parent(resource.projectId, parent);
    const siblings = this.nodes(resource.projectId).filter(node => node.parentId === parentId);
    this.store.put('tree', resource.id, {id: resource.id, projectId: resource.projectId, kind: 'resource', resourceId: resource.id,
      name: resource.name, parentId, position: Math.max(-1, ...siblings.map(node => node.position)) + 1} satisfies ResourceTreeNode);
  }
  edit(projectId: string, input: Record<string, unknown>,actor?:{sessionId:string;eventId:string}) {
    const nodes = this.nodes(projectId);
    const node = nodes.find(node => node.id === input.nodeId);
    if (!['create', 'rename', 'move', 'update', 'delete'].includes(String(input.operation))) throw new HttpError(400, '资源目录操作无效');
    if (input.operation !== 'create' && (!node || node.builtin)) throw new HttpError(404, '目录节点不存在或不可修改');
    if (input.operation === 'delete') { this.archiveNode(projectId, node!,actor); return {nodes: this.nodes(projectId)}; }
    const parentId = input.operation === 'rename'||input.operation==='update'&&!Object.hasOwn(input,'parentId') ? node!.parentId : this.parent(projectId, input.parentId);
    if (input.operation === 'move'||input.operation==='update') {
      let cursor = parentId;
      while (cursor) { if (cursor === node!.id) throw new HttpError(409, '不能将目录移入自身或子目录'); cursor = nodes.find(entry => entry.id === cursor)?.parentId ?? null; }
    }
    const title = input.operation === 'move'||input.operation==='update'&&!Object.hasOwn(input,'name') ? node!.name : name(input.name);
    if (input.operation === 'create' && nodes.length >= 10000) throw new HttpError(413, '资源目录达到上限');
    const next: ResourceTreeNode = node ? {...node, parentId, name: title} :
      {id: id(), projectId, parentId, name: title, kind: 'folder', resourceId: null, position: 0};
    const siblings = nodes.filter(entry => entry.parentId === parentId && entry.id !== next.id).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const index = input.beforeId == null ? node&&parentId===node.parentId?siblings.filter(entry=>entry.position<node.position).length:siblings.length : siblings.findIndex(entry => entry.id === input.beforeId);
    if (index < 0) throw new HttpError(404, '插入位置不属于同一目录');
    siblings.splice(index, 0, next);
    const projected = nodes.filter(entry => entry.id !== next.id).concat(next);
    for (const entry of projected) {
      let cursor: ResourceTreeNode | undefined = entry; const seen = new Set<string>();
      while (cursor) {
        if (seen.has(cursor.id) || seen.size >= 32) throw new HttpError(409, '资源目录包含循环或超过 32 层');
        seen.add(cursor.id); cursor = projected.find(parent => parent.id === cursor!.parentId);
      }
    }
    this.store.transaction(() => {
      // Materialize virtual resource nodes only when this explicit edit needs them.
      for (const entry of nodes) this.store.put('tree', entry.id, entry);
      siblings.forEach((entry, position) => this.store.put('tree', entry.id, {...entry, position}));
      if (next.resourceId && ['rename','update'].includes(String(input.operation))) {
        const resource = this.store.require<Resource>('resources', next.resourceId); this.store.put('resources', resource.id, {...resource, name: title});
      }
    });
    return {nodes: this.nodes(projectId)};
  }
  private assertIdle(projectId: string,actor?:{sessionId:string;eventId:string}) {
    if (this.busy(projectId,actor?.sessionId) || this.store.list<any>('superWorkers').some(worker => worker.projectId === projectId && ['active', 'queued'].includes(worker.state)) ||
      this.store.list<any>('superInputs').some(input => input.projectId === projectId && input.disposition === 'pending'&&!(input.id===actor?.eventId&&input.sessionId===actor?.sessionId)) ||
      this.store.list<any>('terminals').some(terminal => this.store.get<any>('sessions', terminal.sessionId)?.projectId === projectId && !['closed', 'disconnected', 'failed'].includes(terminal.status)))
      throw new HttpError(409, '请先停止项目活动任务和终端，再移入回收站');
  }
  private record(kind: NavigationTrashItem['kind'], key: string, projectId: string, title: string, group: string) {
    this.store.put('navigationTrash', trashKey(kind, key), {kind, id: key, projectId, name: title, projectName: this.store.project(projectId).name, deletedAt: now()} satisfies NavigationTrashItem);
    this.store.put('navigationTrashGroups', trashKey(kind, key), group);
  }
  private archiveNode(projectId: string, root: ResourceTreeNode,actor?:{sessionId:string;eventId:string}) {
    this.assertIdle(projectId,actor); const nodes = this.nodes(projectId), ids = new Set([root.id]);
    for (let depth = 0; depth < 32; depth++) { const size = ids.size; for (const node of nodes) if (node.parentId && ids.has(node.parentId)) ids.add(node.id); if (ids.size === size) break; }
    const group = trashKey(root.kind === 'folder' ? 'folder' : 'resource', root.resourceId ?? root.id);
    this.store.transaction(() => {
      for (const node of nodes.filter(node => ids.has(node.id))) {
        this.store.put('tree', node.id, node);
        this.record(node.kind === 'folder' ? 'folder' : 'resource', node.resourceId ?? node.id, projectId, node.name, group);
      }
    });
  }
  remove(kind: unknown, key: unknown) {
    if (!['resource', 'project'].includes(String(kind)) || typeof key !== 'string') throw new HttpError(400, '回收站对象无效');
    if (hiddenItem(this.store, String(kind), key)) return this.trash();
    if (kind === 'resource') {
      const resource = this.store.require<Resource>('resources', key);
      this.archiveNode(resource.projectId, this.nodes(resource.projectId).find(node => node.resourceId === key)!);
    } else {
      const project = this.store.project(key); this.assertIdle(project.id);
      this.store.transaction(() => this.record('project', key, key, project.name, trashKey('project', key)));
    }
    return this.trash();
  }
  restore(kind: unknown, key: unknown) {
    if (!['resource', 'project', 'folder'].includes(String(kind)) || typeof key !== 'string') throw new HttpError(400, '回收站对象无效');
    const entry = this.store.list<NavigationTrashItem>('navigationTrash').find(entry => entry.kind === kind && entry.id === key);
    if (!entry) throw new HttpError(404, '回收站对象不存在');
    if (kind !== 'project') this.store.project(entry.projectId);
    const group = this.store.get<string>('navigationTrashGroups', trashKey(String(kind), key));
    const restored = this.store.list<NavigationTrashItem>('navigationTrash').filter(item => item.id === key && item.kind === kind || kind === 'folder' && group && this.store.get('navigationTrashGroups', trashKey(item.kind, item.id)) === group);
    this.store.transaction(() => {
      for (const item of restored) {
        this.store.delete('navigationTrash', trashKey(item.kind, item.id));
        this.store.delete('navigationTrashGroups', trashKey(item.kind, item.id));
      }
      const nodes = this.store.list<ResourceTreeNode>('tree');
      for (const node of nodes.filter(node => restored.some(item => item.id === (node.resourceId ?? node.id))))
        if (node.parentId && hiddenItem(this.store, 'folder', node.parentId)) this.store.put('tree', node.id, {...node, parentId: null});
    });
    return this.trash();
  }
  trash() { return {items: this.store.list<NavigationTrashItem>('navigationTrash')}; }
}
