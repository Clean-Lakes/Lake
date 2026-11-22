import type { SessionEvent } from "../../web-agent/shared/contracts";
import { HttpError, LakeStore } from "./store";
import type { StoredSession } from "./store";

const icons = new Set([
  "chat", "document", "terminal", "server", "database", "network", "code",
  "chart", "bug", "shield", "book", "box",
]);
// Older records may still carry tag associations for legacy imports and recovery.
export type Presentation = { icon: string; revision: number; tagIds?: string[] };
export type Position = { pinned: boolean; position: number };

function revision(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new HttpError(400, "有效的 revision 必填");
  return value;
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

  presentation(sessionId: string, data: Record<string, unknown>) {
    if (typeof data.icon !== "string" || !icons.has(data.icon))
      throw new HttpError(400, "Invalid session icon");
    if ("tagIds" in data) throw new HttpError(410, "项目标签已移除");
    const expected = revision(data.revision);
    const icon = data.icon;
    return this.update((changed) => {
      const session = this.store.session(sessionId);
      if (session.presentationRevision !== expected)
        throw new HttpError(409, "会话图标已变更，请刷新后重试");
      const previous = this.store.get<Presentation>("sessionPresentation", sessionId);
      this.store.put<Presentation>("sessionPresentation", sessionId, {
        ...previous, icon, revision: expected + 1,
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
