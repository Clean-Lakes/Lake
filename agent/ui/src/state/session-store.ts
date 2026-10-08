import type { ClientEvent } from "../api/events";
export interface Snapshot {
  session: Record<string, any>;
  cursor: string;
  tasks: Record<string, any>[];
  task_steps: Record<string, any>[];
  specialist_runs: Record<string, any>[];
  execution_sessions: Record<string, any>[];
  actions: Record<string, any>[];
  observations: Record<string, any>[];
  hypotheses: Record<string, any>[];
  evidence: Record<string, any>[];
  session_messages: Record<string, any>[];
  resources: Record<string, any>[];
  services: Record<string, any>[];
}
export class SessionStore {
  snapshot: Snapshot | undefined;
  private readonly seen = new Set<string>();
  readonly text = new Map<string, string>();
  applySnapshot(snapshot: Snapshot): void {
    this.snapshot = structuredClone(snapshot);
    this.seen.clear();
  }
  applyEvent(event: ClientEvent): "applied" | "duplicate" | "gap" {
    if (!this.snapshot) return "gap";
    if (
      this.seen.has(event.eventId) ||
      BigInt(event.sequence) <= BigInt(this.snapshot.cursor)
    )
      return "duplicate";
    if (BigInt(event.sequence) !== BigInt(this.snapshot.cursor) + 1n)
      return "gap";
    this.seen.add(event.eventId);
    this.snapshot.cursor = event.sequence;
    if (event.type === "model.delta") {
      this.text.set(
        event.actor,
        (this.text.get(event.actor) ?? "") + String(event.data.text ?? ""),
      );
      return "applied";
    }
    const table = event.data.table;
    const entity = event.data.entity;
    if (table && entity) {
      if (table === "sessions") {
        if (entity.revision > this.snapshot.session.revision)
          this.snapshot.session = entity;
      } else if (Array.isArray((this.snapshot as any)[table])) {
        const rows = (this.snapshot as any)[table] as Record<string, any>[];
        const at = rows.findIndex((r) => r.id === entity.id);
        if (at < 0) rows.push(entity);
        else if (entity.revision > rows[at]!.revision) rows[at] = entity;
      }
    }
    return "applied";
  }
}
