import type {ChatGroup, SuperWorkspace, WorkSession} from '../../shared/contracts';
import {pilotConversationView} from './PilotWorkspace';
import {conversationActivity, type ConversationAvatarActivity} from './superAgentPresentation';
import {superPilotActivity} from './superPilotActivity';

export type ChatGroupActivityState = 'running' | 'waiting' | 'idle';

export type ChatGroupActivitySummary = {
  state: ChatGroupActivityState;
  workingRoleIds: ReadonlySet<string>;
  waitingRoleIds: ReadonlySet<string>;
  detail?: string;
};

/** Derives live per-group activity and member working/waiting sets from scoped workers, questions, and session state. */
export function chatGroupActivity(
  group: ChatGroup,
  workspace: SuperWorkspace | null | undefined,
  sessions?: readonly WorkSession[],
  activeActivity?: ConversationAvatarActivity,
  connected = true,
): ChatGroupActivitySummary {
  const session = sessions?.find(row => row.id === group.sessionId);
  const groupView = pilotConversationView(workspace ?? null, group.sessionId);
  const pilot = superPilotActivity(groupView, session ?? {id: group.sessionId, projectId: group.projectId}, connected);
  const liveSession = activeActivity?.sessionId === group.sessionId
    ? activeActivity.state
    : conversationActivity(undefined, session?.status);
  const groupQuestions = groupView?.questions ?? [];

  const waitingRoleIds = new Set<string>();
  for (const worker of groupView?.workers ?? []) {
    if (
      worker.assignmentState === 'active'
      && !['completed', 'failed', 'cancelled'].includes(worker.task.state)
      && worker.activity
      && ['waiting_approval', 'waiting_input'].includes(worker.activity.phase)
    ) {
      waitingRoleIds.add(worker.roleId);
    }
  }
  for (const question of groupQuestions) {
    if (question.author.roleId) waitingRoleIds.add(question.author.roleId);
  }

  const workingRoleIds = new Set<string>();
  if (connected && pilot) {
    for (const participant of pilot.participants) {
      if (participant.moving && participant.roleId && !waitingRoleIds.has(participant.roleId)) {
        workingRoleIds.add(participant.roleId);
      }
    }
  }

  let state: ChatGroupActivityState = 'idle';
  if (pilot?.status === 'waiting_approval' || groupQuestions.length > 0 || liveSession === 'waiting') {
    state = 'waiting';
  } else if (connected && (pilot?.animated === true || liveSession === 'running')) {
    state = 'running';
  }

  let detail: string | undefined;
  if (state === 'waiting') {
    const waitingMember = group.members.find(member => waitingRoleIds.has(member.roleId))?.roleName
      ?? groupQuestions[0]?.author.name;
    detail = waitingMember ? `${waitingMember} 等待确认` : '等待确认';
  } else if (state === 'running') {
    const moving = pilot?.participants.filter(participant => participant.moving) ?? [];
    if (moving.length === 1) {
      detail = `${moving[0].name}：${moving[0].detail}`;
    } else if (moving.length > 1) {
      detail = `${moving.map(participant => participant.name).join('、')} 协作中`;
    } else {
      detail = pilot?.label || '正在处理…';
    }
  }

  return {state, workingRoleIds, waitingRoleIds, detail};
}
