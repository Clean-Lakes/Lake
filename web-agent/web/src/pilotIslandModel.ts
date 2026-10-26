import type {SessionSnapshot, SREAgentRole, SREPlanStep, SRETask} from '../../shared/contracts';
import {pilotStepStatus} from './pilotPresentation';
import {sreNeedsVerification} from './sreOperationPolicy';
import {sreRoles} from './sreTranscript';
import {sreActivityLabel} from './SREActivity';

const order: SREAgentRole[] = ['coordinator', 'investigator', 'executor', 'verifier'];
const working = new Set(['running', 'queued', 'waiting_input', 'waiting_approval']);
const terminal = new Set(['completed', 'failed', 'cancelled']);
export type PilotIslandStep = {step: SREPlanStep; status: string};
export type PilotIslandRole = {role: SREAgentRole; name: string; status: string; completed: number; total: number; description: string; action?:string; messageId?: string; waitKind?: 'choice'|'input'};
export type PilotIslandModel = {
  taskId: string; status: SRETask['status']; planId?: string; label: string; detail: string; tone: 'neutral'|'active'|'attention'|'failed';
  completed: number; total: number; steps: PilotIslandStep[]; roles: PilotIslandRole[]; visibleRoles: PilotIslandRole[];
};

function newestTask(tasks: SRETask[], session: SessionSnapshot['session']) {
  const time = (value: string) => Date.parse(value) || 0;
  return tasks.filter(t => t.sessionId === session.id && t.projectId === session.projectId)
    .sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id.localeCompare(a.id))[0];
}

function roleState(states: PilotIslandStep[]) {
  for (const status of ['unknown', 'waiting_approval', 'waiting_input', 'running', 'queued', 'failed', 'paused', 'interrupted']) {
    if (states.some(s => s.status === status)) return status;
  }
  return states.length && states.every(s => s.status === 'succeeded') ? 'succeeded' : 'pending';
}

/** Project the current plan and its latest attempts, never tool counts or prose. */
export function pilotIslandModel(snapshot: SessionSnapshot | null | undefined): PilotIslandModel | null {
  if (!snapshot?.sre?.pilot?.enabled || snapshot.ai?.profile && snapshot.ai.profile !== 'core') return null;
  const saved = newestTask(snapshot.sre.tasks ?? [], snapshot.session);
  if (!saved) return null;
  // Go's not-yet-populated slices can arrive as JSON null during planning.
  const task = {...saved, plans: saved.plans ?? [], runs: saved.runs ?? [], attempts: saved.attempts ?? [], messages: saved.messages ?? []};
  // An old finished Pilot task must not replace the status of a later ordinary turn.
  if (terminal.has(task.status) && snapshot.ai?.turnStartedAt && Date.parse(task.updatedAt) < Date.parse(snapshot.ai.turnStartedAt)) return null;
  const plan = task.plans.at(-1);
  const run = task.runs.filter(r => r.planRevisionId === plan?.id).at(-1);
  const attempts = task.attempts.filter(a => a.planRunId === run?.id);
  const agents = (snapshot.ai?.agentRuns ?? []).filter(a => a.sreTaskId === task.id);
  const dispatched = task.attempts.some(a => a.operations?.some(o => o.status === 'dispatched'));
  const unresolved = task.attempts.some(a => a.operations?.some(sreNeedsVerification));
  const stopped = task.status === 'paused' || terminal.has(task.status);
  const steps: PilotIslandStep[] = (plan?.steps ?? []).map(step => {
    let status = pilotStepStatus(task, plan!, step, agents);
    const inFlight = attempts.filter(a => a.stepId === step.id).at(-1)?.operations?.some(o => o.status === 'dispatched');
    if (stopped && !inFlight && working.has(status)) status = task.status === 'paused' ? 'paused' : 'interrupted';
    if (task.status === 'paused' && status === 'interrupted') status = 'paused';
    return {step, status};
  });
  const planning = !plan ? agents.filter(a => a.workflowStepId === 'plan' && ['running', 'queued'].includes(a.status)).at(-1) : undefined;
  const roles = order.flatMap(role => {
    const own = steps.filter(s => s.step.role === role);
    if (!own.length && planning?.sreRole !== role) return [];
    const status = own.length ? roleState(own) : stopped ? 'paused' : planning!.status;
    const current = own.find(s => ['unknown', 'waiting_approval', 'waiting_input', 'running', 'failed'].includes(s.status)) ?? own.find(s => s.status !== 'succeeded');
    const ids = new Set(attempts.filter(a => own.some(s => s.step.id === a.stepId)).flatMap(a => [a.id, a.reusedFromAttemptId].filter(Boolean)));
    const messageId = [...task.messages].reverse().find(m => m.roleId === role && m.source !== 'user' && !!m.attemptId && ids.has(m.attemptId))?.id;
    const waitingAttempt = attempts.filter(a => a.stepId === own.find(s => s.status === 'waiting_input')?.step.id).at(-1);
    const waitingAgent = agents.find(a => a.id === waitingAttempt?.roleRunId);
    const waitKind: PilotIslandRole['waitKind'] = status === 'waiting_input' ? waitingAgent?.question?.pilot ? 'choice' : 'input' : undefined;
    const currentAgent=agents.find(a=>a.sreRole===role&&a.workflowStepId===current?.step.id&&a.status==='running'&&!a.pending&&!a.question);
    const action=status==='running'&&currentAgent?sreActivityLabel(currentAgent).replace(/^正在/,''):undefined;
    return [{action,role, name: sreRoles[role].name, status, completed: own.filter(s => s.status === 'succeeded').length, total: own.length, description: current?.step.description ?? (own.length ? '本角色步骤已完成' : '制定任务计划'), messageId, waitKind}];
  });
  const active = roles.filter(r => r.status === 'running');
  const queued = roles.filter(r => r.status === 'queued');
  const approvals = roles.filter(r => r.status === 'waiting_approval');
  const choices = roles.filter(r => r.status === 'waiting_input' && r.waitKind === 'choice');
  const inputs = roles.filter(r => r.status === 'waiting_input' && r.waitKind === 'input');
  const failed = steps.some(s => s.status === 'failed');
  let label = '正在调度', tone: PilotIslandModel['tone'] = 'active';
  if (unresolved) { label = '变更待核实'; tone = 'attention'; }
  else if (task.status === 'paused' && dispatched) label = '正在暂停';
  else if (task.status === 'cancelled') { label = '已取消'; tone = 'neutral'; }
  else if (task.status === 'failed' || failed) { label = '检查未完成'; tone = 'failed'; }
  else if (task.status === 'paused') { label = '已暂停'; tone = 'neutral'; }
  else if (task.status === 'completed') { label = task.recoveryStatus === 'verified' ? '验收已通过' : '调查结束'; tone = 'neutral'; }
  else if (approvals.length) { label = '等待审批'; tone = 'attention'; }
  else if (choices.length) { label = '等待选择'; tone = 'attention'; }
  else if (inputs.length || task.status === 'waiting_input') { label = '等待补充'; tone = 'attention'; }
  else if (task.status === 'waiting_approval') { label = '等待审批'; tone = 'attention'; }
  else if (!plan) {label = planning?.status === 'running' ? '制定计划' : '准备计划'; tone = planning?.status === 'running' ? 'active' : 'neutral';}
  else if (task.status === 'draft') { label = '计划待开始'; tone = 'neutral'; }
  else if (active.length > 1) label = '并行协作';
  else if (active.length === 1) label = active[0]!.role === 'verifier' ? '独立复核' : active[0]!.role === 'executor' ? '执行操作' : active[0]!.role === 'coordinator' ? '分析与汇总' : '调查取证';
  else if (queued.length) {label = '排队中'; tone = 'neutral';}
  const completed = steps.filter(s => s.status === 'succeeded').length;
  const detail = [label, task.status === 'completed' && task.outcome === 'inconclusive' ? '结论不充分' : '',
    approvals.length ? `${approvals.length} 位专员等待审批` : '', choices.length ? `${choices.length} 位专员等待选择` : '',
    inputs.length ? `${inputs.length} 位专员等待补充` : '',
    dispatched && task.status === 'paused' ? '原操作仍在执行' : '',
    active.length && !stopped ? `${active.length} 位专员${approvals.length || choices.length || inputs.length || failed ? '继续执行' : '执行中'}` : '',
    queued.length && !stopped ? `${queued.length} 位专员排队中` : '',
    steps.length ? `已完成 ${completed} / ${steps.length} 步骤` : '计划尚未生成'].filter(Boolean).join(' · ');
  const focus = roles.filter(r => working.has(r.status) || ['unknown', 'failed', 'paused', 'interrupted'].includes(r.status));
  return {taskId: task.id, status:task.status, planId: plan?.id, label, detail, tone, completed, total: steps.length, steps, roles, visibleRoles: focus.length ? focus : roles};
}

export function pilotRoleStatus(role: PilotIslandRole) {
  if (role.status === 'waiting_input' && role.waitKind === 'input') return '等待补充';
  return ({running: '执行中', queued: '排队中', waiting_input: '等待选择', waiting_approval: '等待审批', unknown: '待核实', failed: '未完成', paused: '已暂停', interrupted: '已中断', succeeded: '已完成', pending: '待开始'} as Record<string, string>)[role.status] ?? '待开始';
}

/** Show the role requiring attention first, then the actual working specialist. */
export function pilotIslandFocus(model:PilotIslandModel){
 const priority=['unknown','waiting_approval','waiting_input','failed','running','queued','paused','interrupted','succeeded','pending'];
 const preferred: SREAgentRole[]=['investigator','executor','verifier','coordinator'];
 const ranked=[...model.visibleRoles].sort((a,b)=>priority.indexOf(a.status)-priority.indexOf(b.status)||preferred.indexOf(a.role)-preferred.indexOf(b.role));
 const primary=ranked[0];
 const stopped=model.tone==='neutral'||model.tone==='failed';
 const action=stopped?model.label:primary?.status==='running'?primary.action??model.label:primary?pilotRoleStatus(primary):model.label;
 const peer=ranked.find(role=>role!==primary&&role.status==='running')??ranked.find(role=>role!==primary&&['waiting_input','waiting_approval','unknown','queued'].includes(role.status));
 const secondary=peer?`${peer.name} · ${peer.status==='running'?peer.action??(peer.role==='verifier'?'独立复核':'执行中'):pilotRoleStatus(peer)}`:model.detail.includes('结论不充分')?'结论不充分':primary?.description??model.label;
 return {primary,action,secondary};
}
