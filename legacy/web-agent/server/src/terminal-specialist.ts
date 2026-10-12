import type { Evidence, Resource } from "../../shared/contracts.js";
import { Store } from "./store.js";
import { DIAGNOSTICS, isDiagnostic, TerminalService, validCommand } from "./terminal.js";

type Step = { resourceId: string; command: string; reason: string; impact: string; verification: string };
export type TerminalPlan = { summary: string; steps: Step[] };
export type Collection = { summary: string; evidence: Evidence[]; pending: boolean };

/** A bounded executor for the specialist's plan, independent of model permission claims. */
export class TerminalSpecialist {
  constructor(private readonly store: Store, private readonly terminals: TerminalService) {}

  context(sessionId: string, mentionedIds: string[]): object {
    const snapshot = this.store.snapshot(sessionId);
    const resources = snapshot.resources.filter(resource => !mentionedIds.length || mentionedIds.includes(resource.id));
    return {
      resources: resources.map(resource => ({ id: resource.id, name: resource.name, kind: resource.kind, description: resource.description,
        terminals: snapshot.terminals.filter(terminal => terminal.resourceId === resource.id) })),
      diagnostics: DIAGNOSTICS,
      recordedTerminalHistory: this.store.recentHistory(sessionId).map(({ entry, resourceId }) => ({
        id: entry.id, resourceId, command: entry.command, output: entry.output.slice(-2048), exitCode: entry.exitCode,
      })),
    };
  }

  parse(value: unknown, resources: Resource[]): TerminalPlan {
    if (!value || typeof value !== "object") throw Error("终端专员计划格式无效");
    const item = value as Record<string, unknown>;
    if (typeof item.summary !== "string" || !Array.isArray(item.steps) || item.steps.length > 3) throw Error("终端专员最多可提出三个步骤");
    const steps: Step[] = item.steps.map(value => {
      if (!value || typeof value !== "object") throw Error("终端步骤格式无效");
      const step = value as Record<string, unknown>;
      if (typeof step.resourceId !== "string" || !resources.some(resource => resource.id === step.resourceId) || !validCommand(step.command) ||
        ![step.reason, step.impact, step.verification].every(detail => typeof detail === "string" && detail.trim() && detail.length <= 500)) {
        throw Error("终端专员提出了无效目标或命令");
      }
      return { resourceId: step.resourceId, command: step.command, reason: step.reason as string,
        impact: step.impact as string, verification: step.verification as string };
    });
    return { summary: item.summary.slice(0, 3000), steps };
  }

  async collect(sessionId: string, plan: TerminalPlan): Promise<Collection> {
    const specialist = this.store.addSpecialist(sessionId, "terminal", "建立持续终端，执行获授权的检查并读取输出");
    const evidence: Evidence[] = [];
    const lines = [plan.summary];
    try {
      for (const step of plan.steps) {
        this.store.assertSessionResource(sessionId, step.resourceId);
        const terminals = this.store.snapshot(sessionId).terminals.filter(terminal => terminal.resourceId === step.resourceId && terminal.status !== "disconnected");
        let terminal = terminals.find(terminal => terminal.status === "ready" && terminal.holder === "agent") ?? terminals[0];
        if (terminal && terminal.status !== "ready") {
          lines.push("目标终端正在使用或连接中；专员未抢占，也未创建第二个连接。");
          break;
        }
        if (!terminal) terminal = await this.terminals.open(sessionId, step.resourceId);
        if (!isDiagnostic(step.command) || terminal.holder !== "agent") {
          this.store.addAction(sessionId, step.resourceId, step.command, step.reason, step.impact, step.verification, terminal.id);
          lines.push(isDiagnostic(step.command) ? "终端由用户持有，请交接；交接后只读检查会自动执行，无需逐条确认。" : "命令可能变更状态，已生成单次确认；危险命令还需再次确认目标。尚未执行。");
          this.store.finishSpecialist(specialist.id, "completed", lines.join("\n"));
          return { summary: lines.join("\n"), evidence, pending: true };
        }
        const entry = await this.terminals.execute(sessionId, terminal.id, "agent", step.command);
        const result = await this.terminals.wait(sessionId, terminal.id, entry.id);
        evidence.push(this.store.addEvidence(specialist.id, step.resourceId, "终端专员采集的命令输出", result));
        lines.push(`${step.command}：退出码 ${result.exitCode ?? "未知"}`);
        const current = this.store.terminal(sessionId, terminal.id);
        if (current.holder !== "agent" || current.status !== "ready" || result.exitCode === null) {
          lines.push("终端已接管或断开，专员停止后续输入，执行结果需核查。");
          break;
        }
      }
      this.store.finishSpecialist(specialist.id, "completed", lines.join("\n"));
      return { summary: lines.join("\n"), evidence, pending: false };
    } catch (error) {
      this.store.finishSpecialist(specialist.id, "failed", "终端操作未完成；请核对连接或控制权，命令不会自动重发。");
      throw error;
    }
  }
}
