import type { StorePort } from "../domain/ports.js";
import type { SpecialistRun, Activity, Phase } from "../domain/entities.js";
import { changeCommands } from "../domain/events.js";
import { requireCondition, LakeError } from "../domain/errors.js";
export class SpecialistStateService {
  constructor(private readonly store: StorePort) {}
  async changeActivity(
    id: string,
    activity: Activity,
    waitingReason?: string,
    correlation?: { actionId: string; terminalSessionId?: string },
  ): Promise<void> {
    for (let n = 0; n < 10; n++) {
      const r = await this.store.get<SpecialistRun>("specialist_runs", id);
      requireCondition(r, "not_found");
      const time = new Date().toISOString();
      const state = {
        ...r.state,
        activity,
        since: time,
        updatedAt: time,
        revision: r.state.revision + 1,
      };
      if (correlation) {
        state.actionId = correlation.actionId;
        if (correlation.terminalSessionId)
          state.terminalSessionId = correlation.terminalSessionId;
      }
      if (waitingReason) state.waitingReason = waitingReason;
      else delete state.waitingReason;
      try {
        await this.store.transact(
          changeCommands(
            "specialist_runs",
            { ...r, revision: r.revision + 1, state },
            "specialist.state_changed",
            id,
            time,
          ),
        );
        return;
      } catch (e) {
        if (!(e instanceof LakeError && e.code === "conflict")) throw e;
      }
    }
    throw new LakeError("conflict");
  }
  async setPhase(id: string, phase: Phase): Promise<void> {
    const r = await this.store.get<SpecialistRun>("specialist_runs", id);
    requireCondition(r, "not_found");
    await this.store.transact(
      changeCommands(
        "specialist_runs",
        {
          ...r,
          revision: r.revision + 1,
          state: {
            ...r.state,
            phase,
            updatedAt: new Date().toISOString(),
            revision: r.state.revision + 1,
          },
        },
        "specialist.state_changed",
        id,
        new Date().toISOString(),
      ),
    );
  }
}
