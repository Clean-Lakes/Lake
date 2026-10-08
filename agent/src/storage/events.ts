import type { DbCommand, StorePort } from "../domain/ports.js";
import type { DomainEvent, EventInput } from "../domain/events.js";
import type { Entity } from "../domain/entities.js";
export function eventCommand(
  type: DomainEvent["type"],
  entity: Entity,
  actor = "system",
  data: Record<string, unknown> = {},
  lakeId?: string,
): DbCommand {
  const sessionId =
    typeof entity.sessionId === "string"
      ? entity.sessionId
      : typeof entity.rootTaskId === "string"
        ? entity.id
        : undefined;
  const lake =
    lakeId ??
    (typeof entity.lakeId === "string"
      ? entity.lakeId
      : type === "lake.created"
        ? entity.id
        : undefined);
  return {
    op: "event",
    event: {
      type,
      streamId: sessionId ? `session:${sessionId}` : `lake:${lake ?? "system"}`,
      aggregateId: entity.id,
      aggregateRevision: entity.revision,
      actor,
      occurredAt: new Date().toISOString(),
      ...(sessionId ? { sessionId } : {}),
      ...(lake ? { lakeId: lake } : {}),
      data: {
        entity,
        ...(type.startsWith("terminal.")
          ? { table: "execution_sessions" }
          : {}),
        ...data,
      },
    },
  };
}
export class EventStore {
  constructor(private readonly store: StorePort) {}
  async append(input: EventInput): Promise<DomainEvent> {
    return (
      await this.store.transact([{ op: "event", event: input }])
    )[0] as DomainEvent;
  }
  async replay(
    streamId: string,
    after = "0",
    limit = 1000,
  ): Promise<DomainEvent[]> {
    return (
      await this.store.transact([
        { op: "events", streamId, after, limit: Math.min(limit, 1000) },
      ])
    )[0] as DomainEvent[];
  }
}
export async function saveEntity(
  store: StorePort,
  table: string,
  value: Entity,
  type: DomainEvent["type"],
  actor = "system",
  data: Record<string, unknown> = {},
): Promise<void> {
  await store.transact([
    { op: "put", table, value, expectedRevision: value.revision - 1 },
    eventCommand(type, value, actor, data),
  ]);
}
