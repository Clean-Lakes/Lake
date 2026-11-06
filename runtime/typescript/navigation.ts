import type { SessionEvent, WorkspaceTag } from "../../web-agent/shared/contracts";
import { HttpError, id, LakeStore } from "./store";
import type { StoredSession } from "./store";

const colors = new Set(["gray", "green", "blue", "purple", "orange", "red"]);
const icons = new Set([
  "chat", "document", "terminal", "server", "database", "network", "code",
  "chart", "bug", "shield", "book", "box",
]);
export type Presentation = { icon: string; revision: number; tagIds: string[] };
export type Position = { pinned: boolean; position: number };

function revision(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new HttpError(400, "有效的 revision 必填");
  return value;
}
function tagInput(data: Record<string, unknown>) {
  if (typeof data.name !== "string" || !data.name.trim() || [...data.name].length > 40)
    throw new HttpError(400, "标签名称须为 1 至 40 个字符");
  if (typeof data.color !== "string" || !colors.has(data.color))
    throw new HttpError(400, "Invalid tag color");
  return { name: data.name.trim(), color: data.color as WorkspaceTag["color"] };
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export class LakeNavigation {
  constructor(readonly store: LakeStore, readonly publish: (event: SessionEvent) => void) {}

  private update<T>(operation: (changed: Set<string>) => T): T {
    const changed = new Set<string>();
    const events: SessionEvent[] = [];
    const result = this.store.transaction(() => {
      const result = operation(changed);
      for (const sessionId of changed) events.push(this.store.event(sessionId));
      return result;
    });
    // Never publish an event for a rolled-back transaction.
    for (const event of events) this.publish(event);
    return result;
  }

  private associated(tagId: string, changed: Set<string>) {
    for (const session of this.store.list<StoredSession>("sessions"))
      if (this.store.get<Presentation>("sessionPresentation", session.id)?.tagIds.includes(tagId))
        changed.add(session.id);
  }

  createTag(projectId: string, data: Record<string, unknown>) {
    const input = tagInput(data);
    return this.update(() => {
      this.store.project(projectId);
      const tags = this.store.list<WorkspaceTag>("tags").filter((tag) => tag.projectId === projectId);
      if (tags.some((tag) => tag.name === input.name)) throw new HttpError(409, "标签名称已存在");
      if (tags.length >= 64) throw new HttpError(400, "每个项目最多 64 个标签");
      const tag = { id: id(), projectId, ...input };
      return this.store.put("tags", tag.id, tag);
    });
  }

  updateTag(tagId: string, data: Record<string, unknown>) {
    const input = tagInput(data);
    return this.update((changed) => {
      const tag = this.store.require<WorkspaceTag>("tags", tagId);
      this.store.project(tag.projectId);
      if (this.store.list<WorkspaceTag>("tags").some((other) =>
        other.id !== tag.id && other.projectId === tag.projectId && other.name === input.name))
        throw new HttpError(409, "标签名称已存在");
      this.associated(tagId, changed);
      return this.store.put("tags", tagId, { ...tag, ...input });
    });
  }

  deleteTag(tagId: string) {
    return this.update((changed) => {
      const tag = this.store.require<WorkspaceTag>("tags", tagId);
      this.store.project(tag.projectId);
      this.associated(tagId, changed);
      this.store.delete("tags", tagId);
      for (const sessionId of changed) {
        const presentation = this.store.require<Presentation>("sessionPresentation", sessionId);
        presentation.tagIds = presentation.tagIds.filter((id) => id !== tagId);
        // Match the Go contract: deleting a tag does not advance the session's
        // presentation revision. A later explicit save still validates tag scope.
        this.store.put("sessionPresentation", sessionId, presentation);
      }
      return { deleted: true };
    });
  }

  presentation(sessionId: string, data: Record<string, unknown>) {
    if (typeof data.icon !== "string" || !icons.has(data.icon))
      throw new HttpError(400, "Invalid session icon");
    if (!Array.isArray(data.tagIds) || data.tagIds.length > 12)
      throw new HttpError(400, "tagIds must contain at most 12 tags");
    const tagIds = data.tagIds;
    if (tagIds.some((tag) => typeof tag !== "string" || !tag) || new Set(tagIds).size !== tagIds.length)
      throw new HttpError(400, "Invalid or duplicate tag");
    const expected = revision(data.revision);
    const icon = data.icon;
    return this.update((changed) => {
      const session = this.store.session(sessionId);
      if (session.presentationRevision !== expected)
        throw new HttpError(409, "会话标签已变更，请刷新后重试");
      for (const tagId of tagIds)
        if (this.store.get<WorkspaceTag>("tags", tagId)?.projectId !== session.projectId)
          throw new HttpError(404, "Tag not found in session project");
      this.store.put<Presentation>("sessionPresentation", sessionId, {
        icon, tagIds, revision: expected + 1,
      });
      changed.add(sessionId);
      return this.store.session(sessionId);
    });
  }

  move(projectId: string, data: Record<string, unknown>) {
    if (typeof data.sessionId !== "string" || !data.sessionId.trim() || data.sessionId.length > 200)
      throw new HttpError(400, "sessionId 必填");
    if (typeof data.pinned !== "boolean") throw new HttpError(400, "pinned must be boolean");
    const sessionId = data.sessionId.trim(), pinned = data.pinned;
    const before = data.beforeId ?? "";
    if (typeof before !== "string" || (data.beforeId != null && (!before || before === sessionId)))
      throw new HttpError(400, "Invalid insertion target");
    const expected = revision(data.revision, 1e12);
    return this.update((changed) => {
      this.store.project(projectId);
      const current = this.store.get<number>("navigationRevisions", projectId) ?? 0;
      if (current !== expected) throw new HttpError(409, "会话顺序已更新，请刷新后重试");
      const visible = this.store.list<StoredSession>("sessions")
        .filter((session) => session.projectId === projectId)
        .filter((session) => {
          const scope = this.store.get<{ scope: string }>("aiScopes", session.id)?.scope;
          return scope !== "resource-terminal" &&
            (scope !== "enhanced-terminal" || this.store.messages(session.id).length > 0);
        })
        .map((session) => this.store.session(session.id));
      const group = visible.filter((session) => session.id !== sessionId && session.pinned === pinned);
      if (!visible.some((session) => session.id === sessionId) || (before && !group.some((s) => s.id === before)))
        throw new HttpError(404, "会话不在当前项目或目标分组中");
      group.sort((a, b) => {
        if ((a.navigationPosition == null) !== (b.navigationPosition == null))
          return a.navigationPosition == null ? -1 : 1;
        if (a.navigationPosition != null && b.navigationPosition != null && a.navigationPosition !== b.navigationPosition)
          return a.navigationPosition - b.navigationPosition;
        return compare(b.updatedAt, a.updatedAt) || compare(a.id, b.id);
      });
      const ids = group.map((session) => session.id);
      ids.splice(before ? ids.indexOf(before) : ids.length, 0, sessionId);
      ids.forEach((id, position) => this.store.put<Position>("sessionNavigation", id, { pinned, position }));
      this.store.put("navigationRevisions", projectId, current + 1);
      changed.add(sessionId);
      return this.store.session(sessionId);
    });
  }
}
