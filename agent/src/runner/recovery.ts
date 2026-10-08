import type { StorePort } from "../domain/ports.js";
import type {
  Action,
  ExecutionSession,
  SpecialistRun,
} from "../domain/entities.js";
import { changeCommands } from "../domain/events.js";
export class RecoveryService {
  constructor(
    private readonly store: StorePort,
    private readonly reconcile: (id: string) => Promise<unknown>,
    private readonly settleReservation: (
      id: string,
      sessionId: string,
    ) => Promise<void>,
  ) {}
  async recover(): Promise<void> {
    const time = new Date().toISOString();
    for (const a of await this.store.list<Action>("actions"))
      if (["dispatched", "verifying", "observed"].includes(a.status)) {
        await this.store.transact(
          changeCommands(
            "actions",
            { ...a, revision: a.revision + 1, status: "unknown" },
            "action.unknown",
            "recovery",
            time,
          ),
        );
      }
    for (const t of await this.store.list<ExecutionSession>(
      "execution_sessions",
    ))
      if (t.status !== "closed")
        await this.store.transact(
          changeCommands(
            "execution_sessions",
            { ...t, revision: t.revision + 1, status: "disconnected" },
            "terminal.disconnected",
            "recovery",
            time,
          ),
        );
    for (const r of await this.store.list<SpecialistRun>("specialist_runs"))
      if (r.state.status === "running")
        await this.store.transact(
          changeCommands(
            "specialist_runs",
            {
              ...r,
              revision: r.revision + 1,
              state: {
                ...r.state,
                status: "interrupted",
                activity: "idle",
                revision: r.state.revision + 1,
              },
            },
            "specialist.state_changed",
            "recovery",
            time,
          ),
        );
    for (const a of await this.store.list<Action>("actions"))
      if (a.status === "unknown") await this.reconcile(a.id).catch(() => {});
    for (const r of await this.store.list<any>("budget_reservations"))
      if (r.status === "reserved")
        await this.settleReservation(r.id, r.sessionId);
  }
}
