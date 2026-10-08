import { randomUUID } from "node:crypto";
import type { StorePort } from "../domain/ports.js";
import type { Session, SpecialistRun, Budget } from "../domain/entities.js";
import type { ModelUsage } from "../domain/ports.js";
import { LakeError, requireCondition } from "../domain/errors.js";
export function initialBudget(
  maxCalls: number,
  maxTokens: number,
  deadline: string,
): Budget {
  return {
    calls: 0,
    tokens: 0,
    reservedCalls: 0,
    reservedTokens: 0,
    maxCalls,
    maxTokens,
    deadline,
  };
}
export class BudgetService {
  constructor(
    private readonly store: StorePort,
    private readonly prices: ReadonlyArray<{
      id: string;
      inputPricePerMillion?: number | undefined;
      outputPricePerMillion?: number | undefined;
    }> = [],
  ) {}
  async reserve(
    sessionId: string,
    actor: string,
    tokens: number,
    metadata: { kind?: "model" | "compaction"; prefixHash?: string } = {},
  ): Promise<string> {
    requireCondition(
      Number.isSafeInteger(tokens) && tokens > 0,
      "invalid_input",
    );
    for (let n = 0; n < 10; n++) {
      const session = await this.store.get<Session>("sessions", sessionId);
      requireCondition(session, "not_found");
      const child =
        actor === sessionId
          ? undefined
          : await this.store.get<SpecialistRun>("specialist_runs", actor);
      if (actor !== sessionId)
        requireCondition(child?.sessionId === sessionId, "scope_denied");
      for (const b of [session.budget, ...(child ? [child.budget] : [])])
        requireCondition(
          Date.now() < Date.parse(b.deadline) &&
            b.calls + b.reservedCalls < b.maxCalls &&
            b.tokens + b.reservedTokens + tokens <= b.maxTokens,
          "budget_exhausted",
        );
      const id = randomUUID();
      const reserve = {
        id,
        revision: 1,
        sessionId,
        actor,
        tokens,
        ...metadata,
        status: "reserved",
        createdAt: new Date().toISOString(),
      };
      const update = (b: Budget) => ({
        ...b,
        reservedCalls: b.reservedCalls + 1,
        reservedTokens: b.reservedTokens + tokens,
      });
      try {
        await this.store.transact([
          {
            op: "put",
            table: "sessions",
            value: {
              ...session,
              revision: session.revision + 1,
              budget: update(session.budget),
            },
            expectedRevision: session.revision,
          },
          ...(child
            ? [
                {
                  op: "put" as const,
                  table: "specialist_runs",
                  value: {
                    ...child,
                    revision: child.revision + 1,
                    budget: update(child.budget),
                  },
                  expectedRevision: child.revision,
                },
              ]
            : []),
          {
            op: "put",
            table: "budget_reservations",
            value: reserve,
            expectedRevision: 0,
          },
        ]);
        return id;
      } catch (e) {
        if (!(e instanceof LakeError && e.code === "conflict")) throw e;
      }
    }
    throw new LakeError("conflict");
  }
  async settle(
    id: string,
    usage: ModelUsage | null,
    providerId: string,
  ): Promise<void> {
    for (let n = 0; n < 10; n++) {
      const r = await this.store.get<any>("budget_reservations", id);
      requireCondition(r, "not_found");
      if (r.status === "settled") return;
      const session = await this.store.get<Session>("sessions", r.sessionId);
      requireCondition(session, "not_found");
      const child =
        r.actor === session.id
          ? undefined
          : await this.store.get<SpecialistRun>("specialist_runs", r.actor);
      const tokens = usage ? usage.input + usage.output : r.tokens;
      const price = this.prices.find((p) => p.id === providerId);
      const knownPrice =
        price?.inputPricePerMillion !== undefined &&
        price.outputPricePerMillion !== undefined;
      const cost =
        usage && knownPrice
          ? (usage.input * price.inputPricePerMillion! +
              usage.output * price.outputPricePerMillion!) /
            1_000_000
          : null;
      const update = (b: Budget) => ({
        ...b,
        calls: b.calls + 1,
        tokens: b.tokens + tokens,
        reservedCalls: b.reservedCalls - 1,
        reservedTokens: b.reservedTokens - r.tokens,
      });
      try {
        await this.store.transact([
          {
            op: "put",
            table: "sessions",
            value: {
              ...session,
              revision: session.revision + 1,
              budget: update(session.budget),
            },
            expectedRevision: session.revision,
          },
          ...(child
            ? [
                {
                  op: "put" as const,
                  table: "specialist_runs",
                  value: {
                    ...child,
                    revision: child.revision + 1,
                    budget: update(child.budget),
                  },
                  expectedRevision: child.revision,
                },
              ]
            : []),
          {
            op: "put",
            table: "budget_reservations",
            value: { ...r, revision: r.revision + 1, status: "settled" },
            expectedRevision: r.revision,
          },
          {
            op: "put",
            table: "model_usage",
            value: {
              id: randomUUID(),
              revision: 1,
              sessionId: session.id,
              actor: r.actor,
              providerId,
              kind: r.kind ?? "model",
              prefixHash: r.prefixHash ?? null,
              durationMs: Math.max(0, Date.now() - Date.parse(r.createdAt)),
              usage,
              cost,
              costSource: cost === null ? "unknown" : "configured-price",
              source: usage ? "provider" : "estimated",
              estimatedTokens: usage ? null : r.tokens,
            },
            expectedRevision: 0,
          },
        ]);
        return;
      } catch (e) {
        if (!(e instanceof LakeError && e.code === "conflict")) throw e;
      }
    }
    throw new LakeError("conflict");
  }
  async update(
    sessionId: string,
    maxCalls: number,
    maxTokens: number,
    principal: string,
  ): Promise<void> {
    const s = await this.store.get<Session>("sessions", sessionId);
    requireCondition(
      s &&
        Number.isSafeInteger(maxCalls) &&
        maxCalls > 0 &&
        Number.isSafeInteger(maxTokens) &&
        maxTokens > 0,
      "invalid_input",
    );
    const value = {
      ...s,
      revision: s.revision + 1,
      budget: { ...s.budget, maxCalls, maxTokens },
    };
    await this.store.transact([
      { op: "put", table: "sessions", value, expectedRevision: s.revision },
      {
        op: "event",
        event: {
          streamId: `session:${sessionId}`,
          sessionId,
          type: "budget.updated",
          aggregateId: s.id,
          aggregateRevision: value.revision,
          actor: principal,
          occurredAt: new Date().toISOString(),
          data: { maxCalls, maxTokens },
        },
      },
    ]);
  }
}
