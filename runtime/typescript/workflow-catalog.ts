import type {Resource, WorkflowTemplate, WorkflowStep, WorkflowRun} from '../../web-agent/shared/contracts';
import {HttpError, id, LakeStore, now} from './store';

export class LakeWorkflowCatalog {
  constructor(readonly store: LakeStore, readonly redact: (text: string) => string) {}
  validate(projectId: string, input: Record<string, unknown>) {
    this.store.project(projectId);
    const text = (value: unknown, maximum: number) => {
      if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum || value.includes('\0') || this.redact(value) !== value)
        throw new HttpError(400, '工作流名称和目标不能为空、过大或包含凭据');
      return value.trim();
    };
    const name = text(input.name, 120), goal = text(input.goal, 1000), seen = new Set<string>();
    if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 7) throw new HttpError(400, '工作流须包含 1 至 7 个步骤');
    const steps: WorkflowStep[] = input.steps.map(value => {
      if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9_.-]{1,200}$/.test(value.id) || value.id === '_verify' || seen.has(value.id) ||
          !['host', 'application', 'data'].includes(value.role) || !Array.isArray(value.resourceIds) || !value.resourceIds.length || value.resourceIds.length > 3 || new Set(value.resourceIds).size !== value.resourceIds.length)
        throw new HttpError(400, '步骤身份、职责或资源列表无效');
      seen.add(value.id);
      for (const id of value.resourceIds) {
        if (typeof id !== 'string') throw new HttpError(400, '资源身份无效');
        const resource = this.store.require<Resource>('resources', id);
        if (resource.projectId !== projectId || !(value.role === 'data' ? ['database', 'redis'] : ['local', 'ssh']).includes(resource.kind))
          throw new HttpError(400, '工作流只能使用职责匹配的本项目资源');
      }
      return {id: value.id, role: value.role, task: text(value.task, 4000), resourceIds: [...value.resourceIds]};
    });
    return {name, goal, steps};
  }
  list(projectId: string) {
    this.store.project(projectId);
    return {templates: this.store.list<WorkflowTemplate>('workflowTemplates').filter(row => row.projectId === projectId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      runs: this.store.list<WorkflowRun>('workflowRuns').filter(row => row.projectId === projectId)};
  }
  save(projectId: string, input: Record<string, unknown>, key?: string) {
    const template = this.validate(projectId, input);
    return this.store.transaction(() => {
      const previous = key ? this.store.require<WorkflowTemplate>('workflowTemplates', key) : undefined;
      if (previous && previous.projectId !== projectId) throw new HttpError(404, '工作流不属于当前项目');
      if (previous && (!Number.isSafeInteger(input.version) || input.version !== previous.version)) throw new HttpError(409, '工作流版本已变化，请刷新');
      const value: WorkflowTemplate = {id: key ?? id(), projectId, ...template, version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? now(), updatedAt: now()};
      return this.store.put('workflowTemplates', value.id, value);
    });
  }
  remove(projectId: string, key: string, version: unknown) {
    this.store.project(projectId);
    return this.store.transaction(() => {
      const previous = this.store.require<WorkflowTemplate>('workflowTemplates', key);
      if (previous.projectId !== projectId) throw new HttpError(404, '工作流不属于当前项目');
      if (!Number.isSafeInteger(version) || version !== previous.version) throw new HttpError(409, '工作流版本已变化，请刷新');
      // A saved template is not an execution owner. Retain the retired snapshot
      // separately; runs and their frozen original templates remain untouched.
      this.store.put('archivedWorkflowTemplates', key, {...previous, deletedAt: now()}); this.store.delete('workflowTemplates', key); return {deleted: true};
    });
  }
}
