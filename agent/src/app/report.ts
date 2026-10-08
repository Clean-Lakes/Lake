import type { StorePort } from "../domain/ports.js";
import type { DeliveryResult } from "../verification/delivery-gate.js";
export async function buildEvidenceReport(
  store: StorePort,
  taskId: string,
  delivery: DeliveryResult,
): Promise<unknown> {
  const [task, actions, observations, hypotheses, evidence] = await Promise.all(
    [
      store.get<any>("tasks", taskId),
      store.list<any>("actions"),
      store.list<any>("observations"),
      store.list<any>("hypotheses"),
      store.list<any>("evidence"),
    ],
  );
  return {
    objective: task?.objective,
    delivery,
    findings: observations
      .filter((o) => o.taskId === taskId)
      .map(({ id, source, trusted, observedAt, value }) => ({
        id,
        source,
        trusted,
        observedAt,
        value,
      })),
    hypotheses: hypotheses.filter((h) => h.taskId === taskId),
    actions: actions
      .filter((a) => a.taskId === taskId)
      .map(({ id, capability, status, result }) => ({
        id,
        capability,
        status,
        result,
      })),
    evidence: evidence.filter((e) => e.taskId === taskId),
    gaps: delivery.gaps,
  };
}
