import type { StorePort } from "../domain/ports.js";
import type { ExecutionSession, Action } from "../domain/entities.js";
import { requireCondition, LakeError } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
export class InputControl {
  private readonly queues = new Map<string, Promise<void>>();
  constructor(
    private readonly store: StorePort,
    private readonly leaseMs = 30000,
  ) {}
  async claimInput(id: string, holderId: string): Promise<number> {
    const t = await this.store.get<ExecutionSession>("execution_sessions", id);
    requireCondition(t?.status === "ready" && !t.paused, "conflict");
    const busy = (await this.store.list<Action>("actions")).some(
      (a) =>
        a.terminalSessionId === id &&
        ["queued", "dispatched", "unknown", "verifying"].includes(a.status),
    );
    requireCondition(!busy, "conflict", "Terminal action is unsettled");
    requireCondition(
      !t.inputHolder ||
        t.inputHolder === holderId ||
        Date.parse(t.inputExpiresAt ?? "") <= Date.now(),
      "conflict",
      "Terminal input is held",
    );
    const epoch = t.inputEpoch + 1;
    await this.store.transact(
      changeCommands(
        "execution_sessions",
        {
          ...t,
          revision: t.revision + 1,
          inputHolder: holderId,
          inputEpoch: epoch,
          inputExpiresAt: new Date(Date.now() + this.leaseMs).toISOString(),
        },
        "terminal.control_granted",
        holderId,
        new Date().toISOString(),
      ),
    );
    return epoch;
  }
  async validate(
    id: string,
    holderId: string,
    epoch: number,
  ): Promise<ExecutionSession> {
    const t = await this.store.get<ExecutionSession>("execution_sessions", id);
    requireCondition(
      t?.inputHolder === holderId &&
        t.inputEpoch === epoch &&
        Date.parse(t.inputExpiresAt ?? "") > Date.now() &&
        !t.paused,
      "conflict",
      "Terminal input lease is invalid",
    );
    return t;
  }
  async renew(id: string, holderId: string, epoch: number): Promise<void> {
    const t = await this.validate(id, holderId, epoch);
    await this.store.transact([
      {
        op: "put",
        table: "execution_sessions",
        value: {
          ...t,
          revision: t.revision + 1,
          inputExpiresAt: new Date(Date.now() + this.leaseMs).toISOString(),
        },
        expectedRevision: t.revision,
      },
    ]);
  }
  async release(id: string, holderId: string, epoch: number): Promise<void> {
    const t = await this.store.get<ExecutionSession>("execution_sessions", id);
    requireCondition(
      t?.inputHolder === holderId && t.inputEpoch === epoch,
      "conflict",
    );
    const busy = (await this.store.list<Action>("actions")).some(
      (a) =>
        a.terminalSessionId === id &&
        ["dispatched", "unknown", "verifying"].includes(a.status),
    );
    requireCondition(!busy, "unknown_effect");
    await this.store.transact(
      changeCommands(
        "execution_sessions",
        {
          ...t,
          revision: t.revision + 1,
          inputHolder: null,
          inputEpoch: t.inputEpoch + 1,
          inputExpiresAt: null,
        },
        "terminal.control_released",
        holderId,
        new Date().toISOString(),
      ),
    );
  }
  async enqueue(
    id: string,
    holderId: string,
    signal: AbortSignal = AbortSignal.timeout(30000),
  ): Promise<number> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.queues.set(id, tail);
    await previous;
    try {
      while (!signal.aborted) {
        try {
          return await this.claimInput(id, holderId);
        } catch (error) {
          if (!(error instanceof LakeError && error.code === "conflict"))
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      throw new LakeError("cancelled");
    } finally {
      release();
      if (this.queues.get(id) === tail) this.queues.delete(id);
    }
  }
}
