import type { StorePort, ModelMessage } from "../domain/ports.js";
import type { Entity } from "../domain/entities.js";
import { randomUUID } from "node:crypto";
import { requireCondition } from "../domain/errors.js";
export interface Exchange extends Entity {
  sessionId: string;
  actor: string;
  status: "pending" | "complete" | "failed";
  assistant: ModelMessage;
  results: ModelMessage[];
  createdAt: string;
}
export class ModelHistory {
  constructor(
    private readonly store: StorePort,
    readonly sessionId: string,
    readonly actor: string,
  ) {}
  async exchanges(): Promise<Exchange[]> {
    return (await this.store.list<Exchange>("model_exchanges")).filter(
      (e) => e.sessionId === this.sessionId && e.actor === this.actor,
    );
  }
  async messages(): Promise<ModelMessage[]> {
    return (await this.exchanges())
      .filter((e) => e.status === "complete")
      .flatMap((e) => [e.assistant, ...e.results]);
  }
  async pending(): Promise<Exchange | undefined> {
    return (await this.exchanges()).find((e) => e.status === "pending");
  }
  async commitExchange(assistant: ModelMessage): Promise<Exchange> {
    requireCondition(!(await this.pending()), "conflict");
    const value: Exchange = {
      id: randomUUID(),
      revision: 1,
      sessionId: this.sessionId,
      actor: this.actor,
      status: "pending",
      assistant,
      results: [],
      createdAt: new Date().toISOString(),
    };
    await this.store.transact([
      { op: "put", table: "model_exchanges", value, expectedRevision: 0 },
    ]);
    return value;
  }
  async settle(id: string, result: ModelMessage): Promise<void> {
    const row = await this.store.get<Exchange>("model_exchanges", id);
    requireCondition(row?.status === "pending", "conflict");
    requireCondition(
      row.assistant.tool_calls?.some((c) => c.id === result.tool_call_id) &&
        !row.results.some((r) => r.tool_call_id === result.tool_call_id),
      "model_protocol_error",
    );
    await this.store.transact([
      {
        op: "put",
        table: "model_exchanges",
        value: {
          ...row,
          revision: row.revision + 1,
          results: [...row.results, result],
        },
        expectedRevision: row.revision,
      },
    ]);
  }
  async finish(id: string): Promise<void> {
    const row = await this.store.get<Exchange>("model_exchanges", id);
    requireCondition(
      row && row.results.length === (row.assistant.tool_calls?.length ?? 0),
      "model_protocol_error",
    );
    await this.store.transact([
      {
        op: "put",
        table: "model_exchanges",
        value: { ...row, revision: row.revision + 1, status: "complete" },
        expectedRevision: row.revision,
      },
    ]);
  }
}
