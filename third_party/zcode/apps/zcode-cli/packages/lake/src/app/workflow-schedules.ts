import { resourceIdentity } from "../domain/inspection.js";
import { object, text, type Params } from "../domain/validation.js";
import type { RuntimePorts } from "./ports.js";
import type { WorkflowRunService } from "./workflow-run.js";

/** Only Lake operations workflow schedules; generic automations remain native ZCode. */
export class WorkflowSchedules {
  private readonly owner: string;
  private readonly lifetime = new AbortController();
  private active?: Promise<void>;
  constructor(
    private readonly ports: RuntimePorts,
    private readonly workflows: WorkflowRunService,
  ) {
    this.owner = ports.id();
  }
  async tick(): Promise<void> {
    if (this.active) return this.active;
    if (this.lifetime.signal.aborted) return;
    const pending = this.run();
    this.active = pending;
    try {
      await pending;
    } finally {
      if (this.active === pending) this.active = undefined;
    }
  }
  private async run() {
    await this.ports.data.request("schedule.expire", {});
    const claim = object(
      await this.ports.data.request("schedule.claim", { owner: this.owner, lease_ms: 60000 }),
    );
    if (!claim.schedule) return;
    const schedule = object(claim.schedule),
      run = object(claim.run),
      controller = new AbortController(),
      abort = () => controller.abort();
    this.lifetime.signal.addEventListener("abort", abort, { once: true });
    const lease = setInterval(() => {
      void this.ports.data
        .request("schedule.renew", { id: schedule.id, owner: this.owner, lease_ms: 60000 })
        .catch(() => controller.abort());
    }, 20000);
    let status = "unknown";
    try {
      await this.ports.data.request("schedule.update_run", {
        id: run.id,
        owner: this.owner,
        status: "running",
      });
      const definition = object(
        await this.ports.data.request("workflow.v2.get", { id: schedule.workflow_id }),
      );
      if (definition.revision !== schedule.workflow_revision)
        throw new Error("计划工作流版本已变化");
      const resources = (await this.ports.data.request("res.list", {
        lake: schedule.lake_id,
      })) as Params[];
      const anchors = resources.map(resourceIdentity);
      const result = object(
        await this.workflows.execute(
          {
            definition_id: definition.id,
            version: 2,
            lake_id: schedule.lake_id,
            unattended: true,
            trigger: "schedule",
          },
          this.ports.id(),
          controller.signal,
          async (node, calls) => {
            if (node.kind !== "ssh_command" || !this.ports.digest) return false;
            const grants = [];
            for (const call of calls) {
              const target = resources.find(
                (resource) => resource.id === call.target || resource.name === call.target,
              );
              if (!target || !anchors.includes(resourceIdentity(target))) return false;
              grants.push({
                node_id: node.id,
                resource_id: target.id,
                command_sha256: this.ports.digest(text(call, "command")),
              });
            }
            try {
              await this.ports.data.request("schedule.consume", {
                id: schedule.id,
                revision: schedule.workflow_revision,
                calls: grants,
              });
              return true;
            } catch {
              return false;
            }
          },
        ),
      );
      status =
        result.status === "completed"
          ? "completed"
          : result.status === "waiting_approval"
            ? "waiting_approval"
            : "failed";
      await this.ports.data.request("schedule.update_run", {
        id: run.id,
        owner: this.owner,
        status,
        workflow_run_id: result.id ?? "",
        reason: status === "waiting_approval" ? "grant_required" : "",
      });
      this.ports.emit({ type: "schedule", schedule_id: schedule.id, run_id: run.id, status });
    } catch {
      await this.ports.data
        .request("schedule.update_run", {
          id: run.id,
          owner: this.owner,
          status: "unknown",
          reason: "interrupted_or_stale",
        })
        .catch(() => {});
    } finally {
      clearInterval(lease);
      this.lifetime.signal.removeEventListener("abort", abort);
    }
  }
  async close() {
    this.lifetime.abort();
    await this.active?.catch(() => {});
  }
}
