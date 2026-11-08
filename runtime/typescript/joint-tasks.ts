import {HttpError, LakeStore} from './store';
import type {Goal} from './tasks';
import type {SuperTask} from '../../web-agent/shared/contracts';

/** memberIds are execution-ledger IDs, each bound to one role, worker and session. */
export type JointTask = {
  id: string;
  projectId: string;
  title: string;
  memberIds: string[];
  revision: number;
  acceptanceId?: string;
  summary?: string;
};

export function jointTask(store: LakeStore, taskId: string) {
  return store.get<JointTask>('superJointTasks', taskId);
}

/** Only the original accepted goal, or a member covered by the final shared receipt, can supply accepted task memory. */
export function hasAcceptedExecution(store: LakeStore, goal: Goal) {
  if (goal.status !== 'completed') return false;
  if (!goal.sharedTaskId) return goal.acceptanceState === 'pass';
  if (!goal.contributionReceiptId) return false;
  const task = jointTask(store, goal.sharedTaskId);
  if (!task?.acceptanceId || task.projectId !== goal.projectId || !task.memberIds.includes(goal.id)) return false;
  const receipt = store.get<{goalId: string; projectId: string; scope: string; state: string;
    contributionReceipts?: string[]}>('superAcceptance', task.acceptanceId);
  return receipt?.goalId === task.id && receipt.projectId === task.projectId && receipt.scope === 'goal' &&
    receipt.state === 'pass' && receipt.contributionReceipts?.includes(goal.contributionReceiptId) === true;
}

export function jointTaskState(task: JointTask, members: Goal[]) {
  const completed = members.filter(member => member.status === 'completed' && member.contributionReceiptId).length;
  const has = (status: string) => members.some(member => member.status === status);
  let status: SuperTask['state'];
  if (task.acceptanceId) status = 'completed';
  else if (has('blocked')) status = 'blocked';
  else if (has('waiting_user')) status = 'waiting_user';
  else if (has('running')) status = 'running';
  else if (has('waiting_external')) status = 'waiting_external';
  else if (has('paused')) status = 'paused';
  else if (has('failed')) status = 'failed';
  else if (has('cancelled')) status = 'cancelled';
  else status = 'blocked';
  const acceptanceState: Goal['acceptanceState'] = task.acceptanceId ? 'pass' :
    ['blocked', 'failed', 'cancelled'].includes(status) ? 'insufficient' : 'not_evaluated';
  return {status, acceptanceState, completed, total: members.length, summary: task.summary};
}

/** The same goal may be visible by its original ID before and after becoming shared. */
export function joinExecutions(store: LakeStore, taskId: string, addedIds: string[], unresolved: (id: string) => boolean) {
  const register = () => {
    const previous = jointTask(store, taskId);
    const memberIds = [...new Set([...(previous?.memberIds ?? [taskId]), ...addedIds])];
    if (previous && memberIds.length === previous.memberIds.length) return previous;
    if (memberIds.length < 2) throw new HttpError(400, '共同任务至少需要两位专员');
    const members = memberIds.map(id => store.require<Goal>('superGoals', id));
    const primary = members[0];
    if (previous?.acceptanceId || members.some(member => member.projectId !== primary.projectId ||
      member.sharedTaskId && member.sharedTaskId !== taskId || member.acceptanceState === 'pass' ||
      member.status === 'completed' && !previous?.memberIds.includes(member.id) ||
      ['failed', 'cancelled'].includes(member.status) || Date.parse(member.deadlineAt) <= Date.now() || unresolved(member.id)))
      throw new HttpError(409, '共同任务只能在同一项目的有效任务上补派，已结束或待核实的执行不能重新分派');
    if ([new Set(members.map(member => member.roleId)), new Set(members.map(member => member.workerId)),
        new Set(members.map(member => member.sessionId))].some(set => set.size !== members.length))
      throw new HttpError(409, '共同任务需要不同的专员、Worker 和执行会话');
    for (const member of members) if (!member.sharedTaskId) {
      member.sharedTaskId = taskId;
      if (Date.parse(member.deadlineAt) > Date.parse(primary.deadlineAt)) member.deadlineAt = primary.deadlineAt;
      // Registration is orthogonal to the member's running plan, interaction, and execution revision.
      store.put('superGoals', member.id, member);
    }
    const task: JointTask = {id: taskId, projectId: primary.projectId, title: primary.title, memberIds,
      revision: (previous?.revision ?? 0) + 1};
    return store.put('superJointTasks', taskId, task);
  };
  return store.db.isTransaction ? register() : store.transaction(register);
}
