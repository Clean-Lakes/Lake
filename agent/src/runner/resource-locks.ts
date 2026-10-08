import type { DbCommand, StorePort } from "../domain/ports.js";
export class ResourceLockService {
  constructor(
    private readonly store: StorePort,
    private readonly maxReads = 2,
  ) {}
  commands(
    resourceIds: string[],
    owner: string,
    mode: "read" | "write",
  ): DbCommand[] {
    return [...new Set(resourceIds)].sort().map((resourceId) => ({
      op: "lock",
      resourceId,
      owner,
      mode,
      maxReads: this.maxReads,
    }));
  }
  async acquireOrdered(
    resourceIds: string[],
    owner: string,
    mode: "read" | "write",
  ): Promise<void> {
    await this.store.transact(this.commands(resourceIds, owner, mode));
  }
  async release(owner: string): Promise<void> {
    await this.store.transact([{ op: "unlock", owner }]);
  }
}
