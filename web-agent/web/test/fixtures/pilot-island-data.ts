import type {AgentRun, SessionSnapshot, SREAgentRole, SREPlanStep, SRETask} from '../../../shared/contracts';

export type IslandFixtureState = 'running'|'parallel3'|'choice'|'approval'|'paused'|'failed'|'unknown'|'finished'|'planning'|'revised'|'resume'|'cancelled'|'stopping';
const at = '2026-10-26T00:01:00Z';
const specs: [string, SREAgentRole, SREPlanStep['kind'], string][] = [
  ['scope', 'coordinator', 'analyze', '明确任务范围与证据来源'],
  ['metrics', 'investigator', 'observe', '采集主机资源指标'],
  ['logs', 'investigator', 'observe', '核对日志与错误来源'],
  ['memory', 'investigator', 'observe', '检查内存与交换空间'],
  ['disk', 'investigator', 'observe', '检查磁盘占用'],
  ['verify-metrics', 'verifier', 'verify', '独立核对主机采样'],
  ['verify-logs', 'verifier', 'verify', '独立复核日志来源'],
  ['summary', 'coordinator', 'summarize', '汇总证据与剩余缺口'],
];

export function islandFixture(state: IslandFixtureState = 'running', sessionId = 'island-session', projectId = 'island-project'): SessionSnapshot {
  const steps = specs.map(([id, role, kind, description]) => ({id, role, kind, description, resourceIds: ['order-api'], dependsOn: [], completionChecks: ['交付真实证据与结果']}));
  const task = {
    id: 'pilot-island-task', sessionId, projectId, requestId: 'island-request', goal: '只读核对主机资源与日志', scope: ['order-api'], mode: 'assist', status: 'active', outcome: '', recoveryStatus: 'not_applicable', rootCauseStatus: 'unknown', profileId: 'lake.sre.assisted', profileVersion: 1, revision: 1,
    tokenBudget: 100000, budgetSpent: 0, usage: {input: 0, output: 0, total: 0}, pilot: {autoAdvance: false, settingsRevision: 1},
    plans: [{id: 'island-plan', taskId: 'pilot-island-task', version: 1, goal: '只读核对主机资源与日志', taskType: 'investigation', scope: ['order-api'], steps, acceptance: [], changeReason: '', createdAt: at, collaborationVersion: 1}],
    runs: [{id: 'island-run', taskId: 'pilot-island-task', planRevisionId: 'island-plan', status: 'running', profileVersion: 1, startedAt: at}],
    attempts: steps.filter(s => ['scope', 'metrics', 'logs', 'verify-metrics', 'verify-logs'].includes(s.id)).map(s => ({id: `attempt-${s.id}`, planRunId: 'island-run', stepId: s.id, roleRunId: `role-${s.id}`, status: ['logs', 'verify-logs'].includes(s.id) ? 'running' : 'succeeded', startedAt: at, evidence: [], operations: []})),
    messages: [], verifications: [], createdAt: at, updatedAt: at,
  } as SRETask;
  let agents = task.attempts.map(a => ({id: a.roleRunId, sessionId, rootTurnId: 'island-turn', sreTaskId: task.id, sreRole: steps.find(s => s.id === a.stepId)!.role, workflowStepId: a.stepId, role: 'host', task: steps.find(s => s.id === a.stepId)!.description, resourceIds: ['order-api'], status: a.status === 'succeeded' ? 'completed' : 'running', createdAt: at, startedAt: at})) as AgentRun[];
  const logs = task.attempts.find(a => a.stepId === 'logs')!, agent = agents.find(a => a.id === logs.roleRunId)!;
  if (state === 'parallel3') {task.attempts.find(a => a.stepId === 'scope')!.status = 'running'; agents.find(a => a.workflowStepId === 'scope')!.status = 'running';}
  if (state === 'choice') agent.question = {id: 'island-choice', questions: [{id: 'pilot', title: '选择处理方向'}], pilot: {sessionId, taskId: task.id, planRevisionId: 'island-plan', stepId: 'logs', attemptId: logs.id, role: 'investigator', directions: [{id: 'read', title: '读取日志', reason: '核对错误来源', recommended: true, operations: [{id: 'read-log', title: '读取日志', tool: 'read', arguments: {path: '/tmp/lake-island-fixture.log'}, risk: 'readonly'}]}]}};
  if (state === 'approval') agent.pending = {id: 'island-approval', target: '隔离演示资源', risk: 'readonly', call: {id: 'approval-call', name: 'shell', arguments: '{"command":"读取合成日志"}'}};
  if (['paused', 'failed', 'stopping', 'cancelled'].includes(state)) {
    task.status = state === 'cancelled' ? 'cancelled' : 'paused';
    for (const a of task.attempts) if (a.status === 'running') a.status = 'interrupted';
  }
  if (state === 'failed' || state === 'unknown' || state === 'stopping') {
    logs.status = state === 'failed' ? 'failed' : 'running';
    logs.operations = [{id: 'original-op', resourceId: 'order-api', risk: state === 'unknown' ? 'write' : 'readonly', status: state === 'stopping' ? 'dispatched' : 'unknown', call: {id: 'original-call', name: 'shell', arguments: '{}'}}] as typeof logs.operations;
  }
  if (state === 'finished') {
    task.status = 'completed'; task.outcome = 'inconclusive';
    task.attempts = steps.map(s => ({id: `attempt-${s.id}`, planRunId: 'island-run', stepId: s.id, roleRunId: `role-${s.id}`, status: 'succeeded', startedAt: at, finishedAt: at, evidence: [], operations: []}));
  }
  if (state === 'resume') {
    const saved = task.attempts.filter(a => a.status === 'succeeded');
    task.runs.push({...task.runs[0]!, id: 'resume-run', resumeOfRunId: 'island-run'});
    task.attempts.push(...saved.map(a => ({...a, id: `reused-${a.id}`, reusedFromAttemptId: a.id, planRunId: 'resume-run'})), {...logs, id: 'resumed-logs', planRunId: 'resume-run'});
  }
  if (state === 'revised') {
    task.status = 'draft'; task.plans.push({...task.plans[0]!, id: 'revised-plan', version: 2});
  }
  if (state === 'planning') {
    task.status = 'draft'; task.plans = []; task.attempts = []; task.runs = [];
    agents = [{...agent, id: 'plan-role', sreRole: 'coordinator', workflowStepId: 'plan'}];
  }
  task.messages = [{id: 'island-plan-message', taskId: task.id, sessionId, roleId: 'coordinator', roleRunId: 'role-scope', attemptId: 'attempt-scope', kind: 'plan', body: '已明确范围，按计划只读核对。', source: 'runtime', sequence: 1, revision: 1, createdAt: at},
    ...task.attempts.filter(a => a.status === 'running' || a.status === 'interrupted' || a.status === 'failed' || a.planRunId === 'resume-run').map((a, i) => ({id: `message-${a.id}`, taskId: task.id, sessionId, roleId: steps.find(s => s.id === a.stepId)!.role, roleRunId: a.roleRunId, attemptId: a.id, kind: 'progress', body: steps.find(s => s.id === a.stepId)!.description, source: 'runtime', sequence: i + 2, revision: 1, createdAt: at}))] as SRETask['messages'];
  return {session: {id: sessionId, projectId, title: '主机资源状态检查', status: 'investigating', resourceIds: ['order-api'], createdAt: at, updatedAt: at}, resources: [], sre: {enabled: true, featureVersion: 1, pilot: {enabled: true, autoAdvance: false, revision: 1}, tasks: [task]}, ai: {session: sessionId, profile: 'core', status: 'running', rootTurnId: 'island-turn', turnStartedAt: at, agentRuns: agents, cards: [], cardsOffset: 0, totalCards: 0, turns: 1, usage: {input: 0, output: 0, total: 0}}} as SessionSnapshot;
}
