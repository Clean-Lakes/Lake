import type { StorePort } from "../domain/ports.js";
import type { SpecialistRun } from "../domain/entities.js";
import { LakeError } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
export class SpecialistScheduler {
  private readonly active = new Map<string, AbortController>();
  private readonly work = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(
    private readonly store: StorePort,
    private readonly start: (
      run: SpecialistRun,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly limit = 3,
  ) {}
  async schedule(): Promise<void> {
    if (this.stopped) return;
    const queued = (
      await this.store.list<SpecialistRun>("specialist_runs")
    ).filter((r) => r.state.status === "queued");
    for (const r of queued) {
      if (this.active.size >= this.limit) break;
      if (this.active.has(r.id)) continue;
      const controller = new AbortController();
      this.active.set(r.id, controller);
      try {
        await this.store.transact(
          changeCommands(
            "specialist_runs",
            {
              ...r,
              revision: r.revision + 1,
              state: {
                ...r.state,
                status: "running",
                revision: r.state.revision + 1,
              },
            },
            "specialist.started",
            r.id,
            new Date().toISOString(),
          ),
        );
      } catch (e) {
        this.active.delete(r.id);
        if (e instanceof LakeError && e.code === "conflict") continue;
        throw e;
      }
      const work = this.start(
        { ...r, revision: r.revision + 1 },
        controller.signal,
      )
        .catch(() => {})
        .finally(() => {
          this.active.delete(r.id);
          this.work.delete(r.id);
        });
      this.work.set(r.id, work);
    }
  }
  cancel(id: string): void {
    this.active.get(id)?.abort();
  }
  stop(): void {
    this.stopped = true;
    for (const controller of this.active.values()) controller.abort();
  }
  get activeCount(): number {
    return this.active.size;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.work.values()]);
  }
}
