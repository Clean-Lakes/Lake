import type { Evidence, Observation } from "../domain/entities.js";
export class EvidencePolicy {
  isFresh(evidence: Evidence | Observation, now = Date.now()): boolean {
    return (
      evidence.trusted &&
      !evidence.invalidatedAt &&
      Date.parse(evidence.observedAt) <= now &&
      Date.parse(evidence.expiresAt) > now
    );
  }
}
