import type {MessageMention, Resource} from '../../web-agent/shared/contracts';
import {HttpError, LakeStore} from './store';

export type MessageInput = {resourceIds: string[]; mentions: MessageMention[]; references: Record<string, unknown>[]};
export function messageInput(store: LakeStore, sessionId: string, text: string, raw: Record<string, unknown>): MessageInput {
  const {projectId} = store.session(sessionId); store.project(projectId);
  const list = (value: unknown): any[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 32) throw new HttpError(400, '每条消息最多包含 32 个准确引用');
    return value;
  };
  const resources = list(raw.resourceIds);
  if (resources.some(id => typeof id !== 'string') || new Set(resources).size !== resources.length) throw new HttpError(400, '资源引用身份无效');
  const mentions: MessageMention[] = list(raw.mentions).map(value => {
    if (!value || !['resource', 'mcp', 'skill', 'role'].includes(value.kind) || typeof value.id !== 'string' || !value.id || value.id.length > 200 ||
        typeof value.label !== 'string' || !value.label || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) ||
        value.start < 0 || value.end <= value.start || value.end > text.length || text.slice(value.start, value.end) !== value.label)
      throw new HttpError(400, '引用文字或位置已变化，请重新选择');
    return {kind: value.kind, id: value.id, label: value.label, start: value.start, end: value.end};
  }).sort((a, b) => a.start - b.start);
  if (mentions.some((value, index) => index > 0 && mentions[index - 1].end > value.start)) throw new HttpError(400, '消息引用位置不能重叠');
  const resourceIds = [...new Set([...resources, ...mentions.filter(value => value.kind === 'resource').map(value => value.id)])];
  for (const id of resourceIds) {
    const resource = store.require<Resource>('resources', id);
    if (resource.projectId !== projectId) throw new HttpError(403, '资源引用不属于当前项目');
  }
  const references = list(raw.references).map(value => {
    const kind = value?.kind, key = kind === 'mcp' ? 'server_id' : kind === 'skill' ? 'skill_name' : 'role_id';
    if (!['mcp', 'skill', 'role'].includes(kind) || typeof value[key] !== 'string' || !value[key] || value[key].length > 200 ||
        typeof value.label !== 'string' || !value.label || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) ||
        value.start < 0 || value.end <= value.start || value.end > text.length || text.slice(value.start, value.end) !== value.label)
      throw new HttpError(400, '扩展引用文字或身份无效');
    return {kind, [key]: value[key], label: value.label, start: value.start, end: value.end};
  });
  // Selected identities do not grant service permissions or execution authority.
  return {resourceIds, mentions, references};
}
