import type { AgentRun, AgentRunStatus, SessionSnapshot } from "../../shared/contracts";
import type { AgentIconName } from "./AgentIcon";
import { formatElapsed } from "./activity";

export const agentRoles: Record<string, { name: string; label: string; icon: AgentIconName }> = {
  host: {name: "Scout", label: "主机诊断", icon: "host"},
  application: {name: "Trace", label: "应用诊断", icon: "application"},
  data: {name: "Deep", label: "数据诊断", icon: "data"},
  network: {name: "Link", label: "网络诊断", icon: "network"},
  change: {name: "Delta", label: "变更分析", icon: "change"},
  verify: {name: "Beacon", label: "独立验证", icon: "verify"},
  plan: {name: "Pilot", label: "处置规划", icon: "plan"},
  memory: {name: "Scribe", label: "事件复盘", icon: "memory"},
};
export const agentStatusLabels: Record<AgentRunStatus, string> = {
  queued: "排队中", running: "执行中", waiting_approval: "等待确认", waiting_input:"等待回答", completed: "已完成",
  failed: "执行失败", cancelled: "已停止", interrupted: "已中断", unknown: "状态待核查",
};
export const activeAgentStatus = (status: AgentRunStatus) => ["queued", "running", "waiting_approval", "waiting_input"].includes(status);
export function agentIdentity(run: Pick<AgentRun, "role" | "name">) {
  return agentRoles[run.role] || {name: run.name || "子 Agent", label: "任务调查", icon: "other" as const};
}
export function agentSummary(run: AgentRun): string {
  return (run.summary || "").replace(/\bev_[a-f0-9]{32}\b/g, id => {
    const index = (run.evidenceIds || []).indexOf(id);
    return index < 0 ? "未登记证据" : `证据 ${index + 1}`;
  });
}

/** Older specialist rows describe real investigations. Tool cards never create agents. */
export function transcriptAgentRuns(snapshot: SessionSnapshot): AgentRun[] {
  const actual = (snapshot.ai?.agentRuns || []).filter(run => run.sessionId === snapshot.session.id);
  const actualIds = new Set(actual.map(run => run.id));
  const legacy = (snapshot.specialists || []).filter(run => run.sessionId === snapshot.session.id && !actualIds.has(run.id)).map(run => {
    const evidence = (snapshot.evidence || []).filter(item => item.specialistId === run.id && item.sessionId === run.sessionId);
    const role = ({logs: "application", host: "host"} as Record<string, string>)[run.name] || (agentRoles[run.name] ? run.name : "legacy");
    return {id: run.id, sessionId: run.sessionId, role, name: run.name === "terminal" ? "终端专员" : run.name,
      task: run.task, status: ({working: "running", completed: "completed", failed: "failed"} as const)[run.status],
      summary: run.summary || undefined, createdAt: run.createdAt, startedAt: run.createdAt,
      finishedAt: run.finishedAt || undefined, resourceIds: [...new Set(evidence.map(item => item.resourceId))],
      evidenceIds: evidence.map(item => item.id), canCancel: false} satisfies AgentRun;
  });
  return [...actual, ...legacy].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
}

export function agentDuration(run: AgentRun, now: number): string {
  if (!run.startedAt) return run.status === "queued" ? "尚未开始" : "未记录";
  const end = run.finishedAt ? Date.parse(run.finishedAt) : activeAgentStatus(run.status) ? now : NaN;
  const seconds = Math.floor((end - Date.parse(run.startedAt)) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? formatElapsed(seconds) : "未记录";
}

export function agentGroupLabel(runs: AgentRun[], live: boolean): string {
  const running = runs.filter(run => run.status === "running").length;
  if (runs.some(run => run.status === "waiting_approval")) return `等待确认${running ? ` · ${running} 个 Agent 执行中` : ""}`;
  if (running && live) return `正在分析 · ${running} 个 Agent 执行中`;
  if (runs.some(run => run.status === "unknown")) return "部分结果待核查";
  if (runs.some(run => run.status === "failed" || run.status === "interrupted")) return "部分任务未完成";
  if (runs.some(run => run.status === "cancelled")) return "部分任务已停止";
  if (runs.every(run => run.status === "completed")) return live ? "正在汇总结论" : "子任务已完成";
  if (runs.some(run => activeAgentStatus(run.status))) return live ? "等待子任务执行" : "任务状态待核查";
  return "调查记录";
}
