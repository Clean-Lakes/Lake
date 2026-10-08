import type { StorePort } from "../domain/ports.js";
import type { DomainEvent } from "../domain/events.js";
import { publicProjection } from "../domain/schemas.js";
import { LakeError } from "../domain/errors.js";
export async function getSnapshotWithCursor(
  store: StorePort,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const names = [
    "sessions",
    "tasks",
    "task_steps",
    "specialist_runs",
    "execution_sessions",
    "actions",
    "observations",
    "hypotheses",
    "evidence",
    "session_messages",
    "resources",
    "services",
  ];
  const values = await store.transact([
    ...names.map((table) => ({ op: "list" as const, table })),
    { op: "cursor", streamId: `session:${sessionId}` },
  ]);
  const session = (
    values[0] as {
      id: string;
      lakeId: string;
      environmentId: string;
    }[]
  ).find((s) => s.id === sessionId);
  if (!session) throw new LakeError("not_found");
  const snapshot: Record<string, unknown> = { session };
  const root = (values[1] as { id: string; scope: string[] }[]).find(
    (t) => t.id === (session as any).rootTaskId,
  );
  const allowed = new Set(root?.scope ?? []);
  names.forEach((name, i) => {
    if (i === 0) return;
    const rows = values[i] as Record<string, unknown>[];
    snapshot[name] = rows.filter((r) =>
      ["resources", "services"].includes(name)
        ? r.lakeId === session.lakeId &&
          r.environmentId === session.environmentId &&
          (name === "resources"
            ? allowed.has(String(r.id))
            : ((r.resourceBindings ?? []) as { resourceId: string }[]).every(
                (b) => allowed.has(b.resourceId),
              ))
        : r.sessionId === sessionId,
    );
  });
  snapshot.cursor = values.at(-1) as string;
  return publicProjection(snapshot) as Record<string, unknown>;
}
