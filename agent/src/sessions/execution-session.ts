import { randomUUID } from "node:crypto";
import type { StorePort } from "../domain/ports.js";
import type { ExecutionSession, Resource, Action } from "../domain/entities.js";
import { requireCondition } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
export class ExecutionSessionService {
  constructor(
    private readonly store: StorePort,
    private readonly connect: (resource: Resource) => Promise<void>,
  ) {}
  async open(
    sessionId: string,
    resource: Resource,
    powerId: string,
    id: string = randomUUID(),
  ): Promise<ExecutionSession> {
    const old = await this.store.get<ExecutionSession>(
      "execution_sessions",
      id,
    );
    if (old) {
      requireCondition(
        old.sessionId === sessionId && old.resourceId === resource.id,
        "scope_denied",
      );
      requireCondition(
        old.resourceIdentity === resource.identity && old.powerId === powerId,
        "identity_mismatch",
      );
      if (old.status === "ready") return old;
      requireCondition(
        old.status !== "closed" && old.mode === "managed" && !old.paused,
        "conflict",
      );
      requireCondition(
        !(await this.store.list<Action>("actions")).some(
          (a) =>
            a.terminalSessionId === id &&
            ["dispatched", "unknown", "verifying"].includes(a.status),
        ),
        "unknown_effect",
      );
      await this.connect(resource);
      const value = {
        ...old,
        revision: old.revision + 1,
        status: "ready" as const,
        inputHolder: null,
        inputEpoch: old.inputEpoch + 1,
        inputExpiresAt: null,
      };
      await this.store.transact(
        changeCommands(
          "execution_sessions",
          value,
          "terminal.ready",
          "system",
          new Date().toISOString(),
        ),
      );
      return value;
    }
    let value: ExecutionSession = {
      id,
      revision: 1,
      sessionId,
      resourceId: resource.id,
      resourceIdentity: resource.identity,
      powerId,
      mode: "managed",
      status: "opening",
      cwd: resource.kind === "local" ? resource.endpoint : "/",
      inputHolder: null,
      inputEpoch: 0,
      inputExpiresAt: null,
      outputCursor: "0",
      paused: false,
    };
    await this.store.transact(
      changeCommands(
        "execution_sessions",
        value,
        "terminal.opening",
        "system",
        new Date().toISOString(),
      ),
    );
    try {
      await this.connect(resource);
      value = { ...value, revision: 2, status: "ready" };
      await this.store.transact(
        changeCommands(
          "execution_sessions",
          value,
          "terminal.ready",
          "system",
          new Date().toISOString(),
        ),
      );
      return value;
    } catch (error) {
      await this.store.transact(
        changeCommands(
          "execution_sessions",
          { ...value, revision: 2, status: "disconnected" },
          "terminal.disconnected",
          "system",
          new Date().toISOString(),
        ),
      );
      throw error;
    }
  }
  async attach(sessionId: string, id: string): Promise<ExecutionSession> {
    const terminal = await this.store.get<ExecutionSession>(
      "execution_sessions",
      id,
    );
    requireCondition(
      terminal?.sessionId === sessionId && terminal.status !== "closed",
      "scope_denied",
    );
    return terminal;
  }
  async close(sessionId: string, id: string): Promise<void> {
    const t = await this.attach(sessionId, id);
    const actions = await this.store.list<any>("actions");
    requireCondition(
      !actions.some(
        (a) =>
          a.terminalSessionId === id &&
          ["queued", "dispatched", "unknown"].includes(a.status),
      ),
      "unknown_effect",
    );
    await this.store.transact(
      changeCommands(
        "execution_sessions",
        {
          ...t,
          revision: t.revision + 1,
          status: "closed",
          inputHolder: null,
          inputEpoch: t.inputEpoch + 1,
        },
        "terminal.disconnected",
        "system",
        new Date().toISOString(),
      ),
    );
  }
  async read(sessionId: string, id: string, after = "0"): Promise<unknown[]> {
    await this.attach(sessionId, id);
    requireCondition(/^\d+$/.test(after), "invalid_input");
    return (await this.store.list<any>("terminal_chunks")).filter(
      (c) => c.terminalSessionId === id && BigInt(c.cursor) > BigInt(after),
    );
  }
}
