import { z } from "zod";
import type { DbCommand } from "./ports.js";
import type { Entity } from "./entities.js";
export const eventTypes = [
  "lake.created",
  "environment.created",
  "resource.imported",
  "service.imported",
  "grant.created",
  "grant.revoked",
  "session.created",
  "session.user_input",
  "session.context_changed",
  "task.created",
  "task.updated",
  "step.claimed",
  "step.updated",
  "specialist.queued",
  "specialist.started",
  "specialist.state_changed",
  "specialist.message_received",
  "specialist.finished",
  "terminal.opening",
  "terminal.ready",
  "terminal.output",
  "terminal.control_requested",
  "terminal.control_granted",
  "terminal.control_released",
  "terminal.control_expired",
  "terminal.disconnected",
  "terminal.manual_activity",
  "action.proposed",
  "action.approval_required",
  "action.authorized",
  "action.queued",
  "action.dispatched",
  "action.observed",
  "action.unknown",
  "action.finished",
  "observation.recorded",
  "hypothesis.updated",
  "verification.finished",
  "budget.updated",
  "checkpoint.created",
  "recovery.started",
  "recovery.finished",
  "model.delta",
  "model.activity",
  "model.finished",
] as const;
export const EventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.uuid(),
    streamId: z.string(),
    lakeId: z.uuid().optional(),
    sessionId: z.uuid().optional(),
    sequence: z.string().regex(/^\d+$/),
    type: z.enum(eventTypes),
    aggregateId: z.string(),
    aggregateRevision: z.int().positive(),
    actor: z.string(),
    occurredAt: z.iso.datetime(),
    causationId: z.string().optional(),
    correlationId: z.string().optional(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export type DomainEvent = z.infer<typeof EventSchema>;
export type EventInput = Omit<
  DomainEvent,
  "eventId" | "sequence" | "schemaVersion"
>;
export function changeCommands(
  table: string,
  entity: Entity,
  type: DomainEvent["type"],
  actor: string,
  time: string,
): DbCommand[] {
  const sessionId =
    typeof entity.sessionId === "string"
      ? entity.sessionId
      : typeof entity.rootTaskId === "string"
        ? entity.id
        : undefined;
  const lakeId =
    typeof entity.lakeId === "string"
      ? entity.lakeId
      : type === "lake.created"
        ? entity.id
        : undefined;
  return [
    { op: "put", table, value: entity, expectedRevision: entity.revision - 1 },
    {
      op: "event",
      event: {
        streamId: sessionId
          ? `session:${sessionId}`
          : `lake:${lakeId ?? "system"}`,
        ...(sessionId ? { sessionId } : {}),
        ...(lakeId ? { lakeId } : {}),
        type,
        aggregateId: entity.id,
        aggregateRevision: entity.revision,
        actor,
        occurredAt: time,
        data: { table, entity },
      },
    },
  ];
}
export function reduceEvent<
  T extends {
    revision: number;
  },
>(current: T, event: DomainEvent): T {
  if (event.aggregateRevision <= current.revision) return current;
  const data =
    event.data.entity && typeof event.data.entity === "object"
      ? event.data.entity
      : event.data;
  return { ...current, ...data, revision: event.aggregateRevision };
}
