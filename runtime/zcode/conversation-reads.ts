import type { ConversationReadState } from '../../web-agent/shared/contracts';
import { HttpError, LakeStore } from './store';
import { digest } from './tasks';

type Receipt = { revision: number; seen: number; fingerprints: Record<string, string> };
const cursor = (revision: number) => revision ? String(revision).padStart(20, '0') : '';

/** Notification metadata only. Neither a read nor a prose update settles work.
 * A per-item fingerprint avoids recounting history when a message is removed,
 * a tool streams, or a delayed poll acknowledges an older visible revision. */
export function conversationReadState(store: LakeStore, sessionId: string, sources = [sessionId]): ConversationReadState {
  const session = store.session(sessionId);
  const receipt = store.get<Receipt>('conversationReads', sessionId) ?? { revision: 0, seen: 0, fingerprints: {} };
  let changed = false;
  const observe = (key: string, body: string) => {
    if (!body.trim()) return;
    const fingerprint = digest(body);
    if (receipt.fingerprints[key] === fingerprint) return;
    receipt.fingerprints[key] = fingerprint;
    changed = true;
  };
  for (const source of new Set(sources)) {
    if (store.session(source).projectId !== session.projectId) throw new HttpError(404, '消息来源不属于当前项目');
    for (const message of store.messages(source))
      if (message.role === 'assistant' && !message.dispatch) observe(`message:${source}:${message.id}`, message.text);
    const view = store.view(source);
    for (const card of view.cards)
      if (['message', 'text'].includes(card.type)) observe(`card:${source}:${card.id}`, card.content ?? '');
    // Interactions are visible messages too; operation/progress cards alone are not.
    if (view.question) observe(`question:${source}:${view.question.id}`, JSON.stringify(view.question));
    for (const pending of view.pendingApprovals ?? (view.pending ? [view.pending] : []))
      observe(`approval:${source}:${pending.id}`, JSON.stringify(pending));
  }
  if (changed) { receipt.revision++; store.put('conversationReads', sessionId, receipt); }
  return { cursor: cursor(receipt.revision), seenCursor: cursor(receipt.seen) };
}

export function acknowledgeConversation(store: LakeStore, sessionId: string, value: unknown) {
  store.session(sessionId);
  const receipt = store.get<Receipt>('conversationReads', sessionId);
  if (typeof value !== 'string' || !/^\d{20}$/.test(value) || !receipt || value > cursor(receipt.revision))
    throw new HttpError(409, '消息已读位置无效，请刷新会话');
  receipt.seen = Math.max(receipt.seen, Number(value));
  store.put('conversationReads', sessionId, receipt);
  return { cursor: cursor(receipt.seen) };
}
