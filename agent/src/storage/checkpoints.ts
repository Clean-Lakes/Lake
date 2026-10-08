import type { StorePort } from "../domain/ports.js";
import { randomUUID } from "node:crypto";
import { ArtifactStore } from "./artifacts.js";
import { eventCommand } from "./events.js";
import { requireCondition } from "../domain/errors.js";
export class CheckpointStore {
  constructor(
    private readonly store: StorePort,
    private readonly artifacts: ArtifactStore,
  ) {}
  async save(
    sessionId: string,
    actor: string,
    state: unknown,
  ): Promise<string> {
    const artifactId = await this.artifacts.put(
      JSON.stringify({ schemaVersion: 1, state }),
      sessionId,
    );
    const value = {
      id: randomUUID(),
      revision: 1,
      sessionId,
      actor,
      artifactId,
      createdAt: new Date().toISOString(),
    };
    await this.store.transact([
      { op: "put", table: "checkpoints", value, expectedRevision: 0 },
      eventCommand("checkpoint.created", value),
    ]);
    return value.id;
  }
  async load(id: string): Promise<unknown> {
    const row = await this.store.get<{
      artifactId: string;
    }>("checkpoints", id);
    requireCondition(row, "not_found");
    const value = JSON.parse(await this.artifacts.read(row.artifactId));
    requireCondition(value.schemaVersion === 1, "precondition_failed");
    return value.state;
  }
}
