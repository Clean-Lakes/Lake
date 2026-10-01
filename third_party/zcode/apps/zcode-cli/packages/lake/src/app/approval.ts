import type { LakeEvent } from "../domain/protocol.js";

interface PendingApproval { turnID: string; resolve(approved: boolean): void }
export class ApprovalGate {
  private readonly pending = new Map<string, PendingApproval>();
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly emit: (event: LakeEvent) => void) {}
  respond(id: string, approved: boolean): void {
    const key = this.pending.has(id) ? id : [...this.pending.keys()].find(key => this.pending.get(key)?.turnID === id);
    const pending = key ? this.pending.get(key) : undefined;
    if (!pending) throw new Error("审批已过期或不属于当前任务");
    this.pending.delete(key as string); pending.resolve(approved);
  }
  async request(id: string, event: LakeEvent, signal: AbortSignal, turnID = ""): Promise<boolean> {
    const previous = this.tail; let release: () => void = () => {};
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    if (signal.aborted) { release(); return false; }
    try {
      return await new Promise<boolean>(resolve => {
        const abort = () => { this.pending.delete(id); signal.removeEventListener("abort", abort); resolve(false); };
        this.pending.set(id, { turnID, resolve: approved => { signal.removeEventListener("abort", abort); resolve(approved); } });
        signal.addEventListener("abort", abort, { once: true });
        this.emit({ ...event, type: "approval", id: turnID || id, approval_id: id });
        if (signal.aborted) abort();
      });
    } finally { release(); }
  }
}
