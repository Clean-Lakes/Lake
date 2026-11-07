import type {MessageQueue, QueuedMessage} from '../../web-agent/shared/contracts';
import {messageInput} from './message-input';
import {HttpError, id, LakeStore, now} from './store';
import {digest} from './tasks';

type Item = QueuedMessage & {ignoreProjectMemory?: boolean; taskId?: string};
type Queue = MessageQueue & {sessionId: string; items: Item[]; resumedAfterRoot?: string};
type Dispatch = {id: string; sessionId: string; hash: string; state: 'dispatching' | 'unknown' | 'accepted'};

/** Editable user drafts, separate from the Super-agent's admitted-event queue.
 * A process loss during admission never authorizes automatic resubmission. */
export class LakeMessageQueue {
  private sending = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(readonly store: LakeStore, readonly guard: () => void, readonly busy: (sessionId: string) => boolean,
    readonly send: (sessionId: string, item: Item) => Promise<unknown>, readonly notify: (sessionId: string) => void,
    readonly redact: (text: string) => string) {
    for (const queue of store.list<Queue>('messageQueues')) if (queue.items.length) {
      queue.paused = true; queue.revision++; queue.lastError = '上次未发送的消息已保留，请检查后继续；发送状态不明的项目不会自动重发';
      store.put('messageQueues', queue.sessionId, queue);
    }
    this.timer = setInterval(() => this.pump(), 100); this.timer.unref();
  }
  get(sessionId: string): Queue {
    this.store.session(sessionId);
    return {...(this.store.get<Queue>('messageQueues', sessionId) ?? {sessionId, paused: false, revision: 0, lastError: '', items: []}), pushSupported: false};
  }
  private save(queue: Queue, notify = true) { queue.revision++; this.store.put('messageQueues', queue.sessionId, queue); if (notify) this.notify(queue.sessionId); return queue; }
  enqueue(sessionId: string, text: string, raw: Record<string, unknown>) {
    this.guard(); if (!text.trim() || Buffer.byteLength(text) > 256000) throw new HttpError(400, '待发送消息不能为空或过大');
    if (raw.taskId !== undefined && (typeof raw.taskId !== 'string' || !raw.taskId || raw.taskId.length > 200)) throw new HttpError(400, '准确任务身份无效');
    const selected = messageInput(this.store, sessionId, text, raw), queue = this.get(sessionId);
    if (queue.items.length >= 100) throw new HttpError(413, '每个会话最多保留 100 条待发送消息');
    const item: Item = {id: id(), text, ...selected, images: [], files: [], createdAt: now(), ignoreProjectMemory: raw.ignoreProjectMemory === true, taskId: raw.taskId as string | undefined};
    queue.items.push(item); this.save(queue);
    return {queued: true, queuedMessageId: item.id, messageQueue: queue};
  }
  mutate(sessionId: string, input: Record<string, any>) {
    this.guard(); const queue = this.get(sessionId);
    if (!Number.isSafeInteger(input.revision) || input.revision !== queue.revision) throw new HttpError(409, '待发送队列已变化，请刷新');
    if (this.sending.has(sessionId)) throw new HttpError(409, '消息正在接入，请稍后重试');
    const item = queue.items.find(item => item.id === input.id);
    if (input.operation === 'push') throw new HttpError(501, '本轮补充尚需准确任务接入，消息仍保留在队列中');
    if (['edit', 'remove'].includes(input.operation) && !item) throw new HttpError(404, '待发送消息不存在');
    const unresolved = (item: Item) => ['dispatching', 'unknown'].includes(this.store.get<Dispatch>('messageQueueDispatches', item.id)?.state ?? '');
    switch (input.operation) {
      case 'pause': queue.paused = true; break;
      case 'resume':
        if (queue.items.some(unresolved)) throw new HttpError(409, '先前消息接入状态未核实；请检查会话记录并移除该队列副本，不会自动重发');
        queue.paused = false; queue.resumedAfterRoot = this.store.view(sessionId).rootTurnId ?? ''; break;
      case 'remove': queue.items = queue.items.filter(entry => entry.id !== item!.id); break;
      case 'edit': {
        if (unresolved(item!)) throw new HttpError(409, '先前发送状态未核实，不能通过编辑重发');
        if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 256000) throw new HttpError(400, '待发送消息无效');
        const text = this.redact(input.text), selected = messageInput(this.store, sessionId, text, input);
        Object.assign(item!, {text, ...selected}); break;
      }
      case 'reorder': {
        if (!Array.isArray(input.ids) || input.ids.length !== queue.items.length || new Set(input.ids).size !== input.ids.length || input.ids.some((id: unknown) => typeof id !== 'string' || !queue.items.some(item => item.id === id))) throw new HttpError(409, '排序须恰好包含全部待发送消息');
        queue.items = input.ids.map((id: string) => queue.items.find(item => item.id === id)!); break;
      }
      default: throw new HttpError(400, '队列操作无效');
    }
    queue.lastError = ''; return this.save(queue);
  }
  pause(sessionId: string, reason = '已停止，待发送消息保留') {
    const queue = this.get(sessionId); if (!queue.items.length) return;
    queue.paused = true; queue.lastError = reason; this.save(queue);
  }
  pauseProject(projectId: string) { for (const queue of this.store.list<Queue>('messageQueues')) if (this.store.session(queue.sessionId).projectId === projectId) this.pause(queue.sessionId); }
  async archiveSession(sessionId: string) {
    await this.sending.get(sessionId);
    const queue = this.store.get<Queue>('messageQueues', sessionId);
    if (queue) this.store.transaction(() => { this.store.put('archivedMessageQueues', sessionId, {...queue, paused: true}); this.store.delete('messageQueues', sessionId); });
  }
  private pump() {
    if (this.closed) return;
    for (const queue of this.store.list<Queue>('messageQueues')) {
      if (queue.paused || !queue.items.length || this.sending.has(queue.sessionId)) continue;
      try { if (this.busy(queue.sessionId)) continue; } catch { this.pause(queue.sessionId, '当前会话不可接入，待发送消息已保留'); continue; }
      const work = this.dispatch(queue).finally(() => this.sending.delete(queue.sessionId)); this.sending.set(queue.sessionId, work);
    }
  }
  private async dispatch(queue: Queue) {
    const item = queue.items[0];
    try {
      this.guard(); this.store.project(this.store.session(queue.sessionId).projectId);
      const view = this.store.view(queue.sessionId);
      if (['failed', 'cancelled', 'interrupted'].includes(view.status) && queue.resumedAfterRoot !== (view.rootTurnId ?? '')) { this.pause(queue.sessionId, '上一轮未完成，待发送队列已暂停，请检查后继续'); return; }
      if (this.store.get<Dispatch>('messageQueueDispatches', item.id)) { this.pause(queue.sessionId, '先前接入状态需要核实，不会自动重发'); return; }
      // Revalidate references at dispatch, not just when the draft was saved.
      messageInput(this.store, queue.sessionId, item.text, item);
      this.store.put('messageQueueDispatches', item.id, {id: item.id, sessionId: queue.sessionId, hash: digest(item), state: 'dispatching'} satisfies Dispatch);
      await this.send(queue.sessionId, item);
      this.store.transaction(() => {
        this.store.put('messageQueueDispatches', item.id, {id: item.id, sessionId: queue.sessionId, hash: digest(item), state: 'accepted'} satisfies Dispatch);
        const latest = this.get(queue.sessionId); latest.items = latest.items.filter(entry => entry.id !== item.id); delete latest.resumedAfterRoot; this.save(latest, false);
      });
      this.notify(queue.sessionId);
    } catch (error) {
      const intent = this.store.get<Dispatch>('messageQueueDispatches', item.id); if (intent) this.store.put('messageQueueDispatches', item.id, {...intent, state: 'unknown'});
      this.pause(queue.sessionId, this.redact(error instanceof HttpError ? error.message : '待发送消息接入失败，请核实后继续'));
    }
  }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.allSettled(this.sending.values()); }
}
