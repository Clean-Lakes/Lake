import { randomUUID } from "node:crypto";
import type { StorePort } from "../domain/ports.js";
import type {
  Observation,
  Hypothesis,
  Evidence,
  Resource,
} from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
import { canonicalActionDigest } from "../operations/action-digest.js";
import { EvidencePolicy } from "../verification/evidence-policy.js";
export async function recordObservation(
  store: StorePort,
  sessionId: string,
  taskId: string,
  resourceId: string,
  value: unknown,
  id: string = randomUUID(),
): Promise<Observation> {
  const old = await store.get<Observation>("observations", id);
  if (old) return old;
  const observation: Observation = {
    id,
    revision: 1,
    sessionId,
    taskId,
    resourceId,
    source: "model_claim",
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    fingerprint: canonicalActionDigest(value),
    value,
    trusted: false,
  };
  await store.transact(
    changeCommands(
      "observations",
      observation,
      "observation.recorded",
      "model",
      new Date().toISOString(),
    ),
  );
  return observation;
}
export async function updateHypothesis(
  store: StorePort,
  input: {
    id?: string;
    taskId: string;
    sessionId: string;
    claim: string;
    status: Hypothesis["status"];
    supportingEvidence: string[];
    refutingEvidence: string[];
    nextProbe: string;
  },
): Promise<Hypothesis> {
  const id = input.id ?? randomUUID(),
    old = await store.get<Hypothesis>("hypotheses", id);
  if (old)
    requireCondition(
      old.taskId === input.taskId && old.sessionId === input.sessionId,
      "scope_denied",
    );
  requireCondition(
    input.status !== "confirmed",
    "precondition_failed",
    "Root cause confirmation requires independent verification",
  );
  const evidence = [
    ...(await store.list<Observation>("observations")),
    ...(await store.list<Evidence>("evidence")),
  ];
  for (const ref of [...input.supportingEvidence, ...input.refutingEvidence])
    requireCondition(
      evidence.some(
        (e) =>
          e.id === ref &&
          e.taskId === input.taskId &&
          new EvidencePolicy().isFresh(e),
      ),
      "precondition_failed",
    );
  const value = {
    ...input,
    id,
    revision: (old?.revision ?? 0) + 1,
  } as Hypothesis;
  await store.transact(
    changeCommands(
      "hypotheses",
      value,
      "hypothesis.updated",
      "model",
      new Date().toISOString(),
    ),
  );
  return value;
}
