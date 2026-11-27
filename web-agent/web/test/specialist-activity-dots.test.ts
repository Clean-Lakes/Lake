import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ChatGroup, SpecialistChannelInfo, SuperTask, SuperWorker, SuperWorkspace, WorkSession} from '../../shared/contracts';
import {ChatGroupNavigation} from '../src/ChatGroup';
import {chatGroupActivity} from '../src/chatGroupActivity';
import {PilotWorkspace} from '../src/PilotWorkspace';
import {SidebarPilotEntry} from '../src/SidebarPilotEntry';

const baseTask: SuperTask = {
  taskId: 'task-1',
  sessionId: 'worker-session-1',
  projectId: 'p',
  title: '排查 192.168.2.141 链路',
  state: 'running',
  acceptanceState: 'not_evaluated',
  revision: 1,
  originRootTurnId: 'turn-1',
  deadlineAt: '',
};

const obsChannel: SpecialistChannelInfo = {
  id: 'channel-obs',
  projectId: 'p',
  roleId: 'obs',
  roleName: '发布专员',
  sessionId: 'obs-channel',
  revision: 1,
  createdAt: '',
};

const dbChannel: SpecialistChannelInfo = {
  id: 'channel-db',
  projectId: 'p',
  roleId: 'db',
  roleName: '数据库专员',
  sessionId: 'db-channel',
  revision: 1,
  createdAt: '',
};

test('rail specialists and Lake coordinator show three-dot bubbles while working and distinct badges for waiting or unread', () => {
  const workspace: SuperWorkspace = {
    active: true,
    project: {projectId: 'p', routerSessionId: 'pilot', version: 1},
    workers: [],
    channels: [
      {...obsChannel, running: true},
      {...dbChannel, id: 'channel-wait', needsConfirmation: true},
      {id: 'channel-unread', projectId: 'p', roleId: 'net', roleName: '网络专员', sessionId: 'net-channel', revision: 1, createdAt: '', messageRead: {cursor: '2', seenCursor: '1'}},
    ],
  };

  const rail = renderToStaticMarkup(createElement(PilotWorkspace, {
    workspace,
    error: '',
    selectedId: null,
    showHeading: false,
    presentation: 'rail',
    onPilot() {},
    onWorker() {},
    onChannel() {},
  }));

  assert.match(rail, /data-activity="running"/);
  assert.match(rail, /activity-dots-bubble is-compact activity-indicator/);
  assert.match(rail, /data-activity="waiting"[^>]*><span class="sidebar-specialist-attention-dot"/);
  assert.match(rail, /data-activity="unread"[^>]*><span class="pilot-worker-unread"/);

  const pilotEntry = renderToStaticMarkup(createElement(SidebarPilotEntry, {
    selected: false,
    activity: 'running',
    onPilot() {},
  }));
  assert.match(pilotEntry, /data-activity="running"/);
  assert.match(pilotEntry, /pilot-worker-running[^>]*><span class="activity-dots-bubble activity-indicator"/);
});

test('group list reflects live active workers per group with three-dot bubbles and leaves idle sibling groups still', () => {
  const groups: ChatGroup[] = [
    {
      sessionId: 'group-obs',
      projectId: 'p',
      title: '可观测群',
      members: [
        {roleId: 'obs', roleName: '发布专员'},
        {roleId: 'db', roleName: '数据库专员'},
      ],
      updatedAt: '',
      latest: {text: '上次巡检结论', author: '发布专员'},
    },
    {
      sessionId: 'group-ops',
      projectId: 'p',
      title: '服务器运维群',
      members: [{roleId: 'db', roleName: '数据库专员'}],
      updatedAt: '',
      latest: {text: '保持静置状态', author: '数据库专员'},
    },
  ];

  const activeWorker: SuperWorker = {
    id: 'w-obs',
    roleId: 'obs',
    roleName: '发布专员',
    sessionId: 'worker-obs-session',
    pilotSessionId: 'group-obs',
    assignmentState: 'active',
    task: {...baseTask, sessionId: 'worker-obs-session'},
    activity: {phase: 'tool', label: '核查抓帧链路', updatedAt: '2026-11-27T08:00:00Z'},
  };

  const workspace: SuperWorkspace = {
    active: true,
    project: {projectId: 'p', routerSessionId: 'pilot', version: 1},
    workers: [activeWorker],
    channels: [obsChannel, dbChannel],
    chatGroups: groups,
  };

  const summary = chatGroupActivity(groups[0]!, workspace, []);
  assert.equal(summary.state, 'running');
  assert.deepEqual([...summary.workingRoleIds], ['obs']);
  assert.equal(summary.detail, '发布专员：核查抓帧链路');

  const offlineSummary = chatGroupActivity(groups[0]!, workspace, [], undefined, false);
  assert.equal(offlineSummary.state, 'idle');
  assert.equal(offlineSummary.workingRoleIds.size, 0);

  const html = renderToStaticMarkup(createElement(ChatGroupNavigation, {
    groups,
    selectedId: 'group-obs',
    workspace,
    sessions: [] as WorkSession[],
    onOpen() {},
  }));

  assert.match(html, /class="nav-row chat-group-nav-row" aria-current="page" data-activity="running"/);
  assert.match(html, /activity-dots-bubble activity-indicator/);
  assert.match(html, /发布专员：核查抓帧链路/);
  assert.match(html, /data-activity="running"><span class="super-role-avatar"[^>]*data-motion="working"/);
  assert.match(html, /数据库专员：保持静置状态/);
  assert.equal((html.match(/activity-dots-bubble/g) ?? []).length, 1);
});

test('group rows elevate waiting confirmations over running dots when any member awaits user input', () => {
  const group: ChatGroup = {
    sessionId: 'group-rel',
    projectId: 'p',
    title: '发布工作群',
    members: [
      {roleId: 'obs', roleName: '发布专员'},
      {roleId: 'db', roleName: '数据库专员'},
    ],
    updatedAt: '',
  };

  const waitingWorker: SuperWorker = {
    id: 'w-wait',
    roleId: 'obs',
    roleName: '发布专员',
    sessionId: 'worker-wait-session',
    pilotSessionId: 'group-rel',
    assignmentState: 'active',
    task: {...baseTask, sessionId: 'worker-wait-session'},
    activity: {phase: 'waiting_approval', label: '等待执行确认', updatedAt: '2026-11-27T08:00:00Z'},
  };

  const workspace: SuperWorkspace = {
    active: true,
    project: {projectId: 'p', routerSessionId: 'pilot', version: 1},
    workers: [waitingWorker],
    channels: [obsChannel, dbChannel],
    chatGroups: [group],
  };

  const html = renderToStaticMarkup(createElement(ChatGroupNavigation, {
    groups: [group],
    selectedId: null,
    workspace,
    onOpen() {},
  }));

  assert.match(html, /data-activity="waiting"/);
  assert.match(html, /pilot-worker-confirmation">需确认/);
  assert.match(html, /发布专员 等待确认/);
  assert.doesNotMatch(html, /activity-dots-bubble/);
});
