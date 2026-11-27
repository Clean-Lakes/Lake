import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GatewayApprovalRequest, SuperWorkspace, WorkSession } from '../../shared/contracts';
import { pilotConversationView } from '../src/PilotWorkspace';
import { superPilotActivity } from '../src/superPilotActivity';

const css = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context);
  },
});
const { PilotGatewayApprovals } = await import('../src/PilotGatewayApprovals');
css.deregister();

const sampleApproval: GatewayApprovalRequest = {
  id: 'appr-1',
  projectId: 'proj-1',
  sessionId: 'pilot-1',
  connectionId: 'conn-1',
  connectionName: '发布专员 MCP',
  roleId: 'role-release',
  roleName: '发布专员',
  avatarId: 'beaver',
  requester: '林明 · WorkBuddy',
  threadId: 'thread-1',
  instructionId: 'msg-1',
  eventId: 'ev-1',
  askText: '林明请我把订单服务发布到 GOS 预发。需要我创建任务并执行吗？',
  title: '发布订单服务至 GOS 预发',
  summary: '将由「发布专员」创建独立任务执行，并实时同步进度与结果给外部请求方。',
  fields: [
    { label: '发布目标', value: '订单服务' },
    { label: '目标环境', value: 'GOS 预发' },
    { label: '目标版本', value: 'v2.14.3-rc2' },
    { label: '发布后检查', value: '服务健康状态' },
  ],
  resourceIds: ['res-1'],
  resourceNames: ['GOS 预发'],
  rawRequest: '帮我把订单服务发到 GOS 预发 v2.14.3-rc2',
  status: 'pending',
  createdAt: '2026-11-27T02:00:00Z',
};

test('PilotGatewayApprovals renders specialist identity, dynamic fields, raw request and approve/reject actions', () => {
  const html = renderToStaticMarkup(
    createElement(PilotGatewayApprovals, {
      approvals: [sampleApproval],
      connected: true,
      onDecided: async () => {},
    }),
  );
  assert.ok(html.includes('发布专员'));
  assert.ok(html.includes('来自 林明 · WorkBuddy'));
  assert.ok(html.includes(sampleApproval.askText));
  assert.ok(html.includes('发布目标') && html.includes('订单服务'));
  assert.ok(html.includes('目标版本') && html.includes('v2.14.3-rc2'));
  assert.match(html, /<li class="pilot-gateway-approval-resource">GOS 预发<\/li>/);
  assert.ok(html.includes('查看原始请求') && html.includes(sampleApproval.rawRequest));
  assert.ok(html.includes('拒绝') && html.includes('同意'));
  assert.equal(
    renderToStaticMarkup(createElement(PilotGatewayApprovals, { approvals: [], connected: true, onDecided: async () => {} })),
    '',
  );
});

test('PilotGatewayApprovals defers rendering a large resource list until expanded', () => {
  const resourceNames = Array.from({ length: 320 }, (_, index) => `测试主机-${index}`);
  const html = renderToStaticMarkup(createElement(PilotGatewayApprovals, {
    approvals: [{ ...sampleApproval, resourceNames, resourceIds: resourceNames }],
    connected: true,
    onDecided: async () => {},
  }));
  assert.match(html, /授权资源（320 项）/);
  assert.doesNotMatch(html, /测试主机-/);
  assert.match(html, /查看原始请求/);
  assert.match(html, /同意/);
});

test('PilotGatewayApprovals shows decided status and optional rejection reason', () => {
  const rejectedHtml = renderToStaticMarkup(
    createElement(PilotGatewayApprovals, {
      approvals: [{ ...sampleApproval, status: 'rejected', decisionReason: '封板窗口暂停发布' }],
      connected: true,
      onDecided: async () => {},
    }),
  );
  assert.ok(rejectedHtml.includes('已拒绝'));
  assert.ok(rejectedHtml.includes('封板窗口暂停发布'));
  assert.doesNotMatch(rejectedHtml, /同意/);
});

test('PilotGatewayApprovals offers one batch decision for the pending rows', () => {
  const html = renderToStaticMarkup(createElement(PilotGatewayApprovals, {
    approvals: [sampleApproval, { ...sampleApproval, id: 'appr-2' }, {
      ...sampleApproval, id: 'appr-3', status: 'approved',
    }],
    connected: true,
    onDecided: async () => {},
  }));
  assert.match(html, /全部同意（2）/);
  assert.match(html, /class="pilot-gateway-approval-list"/);
  assert.match(html, /class="pilot-gateway-approval-item"/);
  assert.ok(html.includes(sampleApproval.title));
  assert.ok(!html.includes(sampleApproval.rawRequest));
});

test('external MCP approvals belong to the Lake main chat', () => {
  const router = { id: 'pilot-1', projectId: 'proj-1', status: 'idle' } as WorkSession;
  const ws: SuperWorkspace = {
    active: true,
    project: { projectId: 'proj-1', routerSessionId: 'pilot-1', version: 1 },
    workers: [],
    gatewayApprovals: [sampleApproval],
    chatGroups: [{
      projectId: 'proj-1', sessionId: 'group-1', title: '发布工作群', members: [], updatedAt: '',
    }],
  };
  const main = pilotConversationView(ws, router.id)!;
  const activity = superPilotActivity(main, router, true);
  assert.ok(activity);
  assert.equal(activity.status, 'waiting_approval');
  assert.equal(activity.phase, 'waiting_approval');
  assert.equal(activity.animated, false);
  assert.match(activity.label, /发布专员.*等待确认外部请求/);

  const group = { ...router, id: 'group-1' };
  const groupView = pilotConversationView(ws, group.id)!;
  assert.equal(groupView.gatewayApprovals, undefined);
  assert.equal(superPilotActivity(groupView, group, true), null);
});
