import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '../../shared/contracts';
import { TranscriptMessage } from '../src/AIPanel';

const css = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context);
  },
});
const { SpecialistMcpInviteSlot, selectSpecialistInviteSlot } = await import('../src/SpecialistMcpDialog');
css.deregister();

test('TranscriptMessage renders specialist MCP messages as proactive left-aligned specialist notifications instead of user bubbles', () => {
  const message: Message = {
    id: 'msg-mcp-1',
    sessionId: 'pilot-1',
    role: 'user',
    text: '帮我把 order-service v2.4.1 发布到 GOS 预发，发布后检查服务健康状态。',
    createdAt: '2026-11-27T04:00:00Z',
    external: {
      kind: 'mcp',
      connectionId: 'conn-1',
      connectionName: '发布专员 MCP',
      threadId: 'thread-1',
      threadTitle: '预发发布',
      specialistNotice: {
        roleId: 'role-release',
        roleName: '发布专员',
        avatarId: 'beaver',
        channelSessionId: 'chan-release',
        resourceNames: ['GOS 预发'],
      },
    },
  };
  const html = renderToStaticMarkup(createElement(TranscriptMessage, {
    sessionId: 'pilot-1',
    message,
    assistantIdentity: { name: 'Lake', pilot: true },
  }));
  assert.match(html, /specialist-mcp-notice/);
  assert.match(html, /ai-role-assistant/);
  assert.doesNotMatch(html, /ai-role-user/);
  assert.doesNotMatch(html, /external-origin-badge/);
  assert.match(html, /发布专员/);
  assert.match(html, /来自 发布专员 MCP/);
  assert.match(html, /我收到一条外部 MCP 消息，已开始在授权范围内处理/);
  assert.match(html, /GOS 预发/);
  assert.match(html, /order-service v2\.4\.1/);
});

test('selectSpecialistInviteSlot allows at most one live invite per specialist', () => {
  const empty = selectSpecialistInviteSlot([]);
  assert.equal(empty.canCreate, true);
  assert.equal(empty.current, null);

  const active = selectSpecialistInviteSlot([
    { id: 'inv-1', name: '研发预发接入', createdAt: '2026-11-27T02:00:00Z', expiresAt: '2026-11-28T02:00:00Z', status: 'active' },
  ]);
  assert.equal(active.canCreate, false);
  assert.equal(active.current?.id, 'inv-1');

  const redeemed = selectSpecialistInviteSlot([
    { id: 'inv-2', name: '生产巡检接入', createdAt: '2026-11-27T02:00:00Z', expiresAt: '2026-11-28T02:00:00Z', redeemedAt: '2026-11-27T02:05:00Z', status: 'redeemed' },
  ]);
  assert.equal(redeemed.canCreate, false);
  assert.equal(redeemed.current?.id, 'inv-2');

  const expired = selectSpecialistInviteSlot([
    { id: 'inv-3', name: '过期链接', createdAt: '2026-11-25T02:00:00Z', expiresAt: '2026-11-26T02:00:00Z', status: 'expired' },
  ]);
  assert.equal(expired.canCreate, true);
  assert.equal(expired.current, null);
  assert.equal(expired.lastInactive?.id, 'inv-3');

  const revoked = selectSpecialistInviteSlot([
    { id: 'inv-4', name: '已撤销链接', createdAt: '2026-11-25T02:00:00Z', expiresAt: '2026-11-26T02:00:00Z', revokedAt: '2026-11-25T03:00:00Z', status: 'revoked' },
  ]);
  assert.equal(revoked.canCreate, true);
  assert.equal(revoked.current, null);
});

test('SpecialistMcpInviteSlot hides creation form when an active or redeemed invite exists', () => {
  const baseProps = {
    roleName: '发布专员',
    connectionEnabled: true,
    busy: '',
    inviteName: '',
    ttlMinutes: '15',
    onInviteNameChange: () => {},
    onTtlMinutesChange: () => {},
    onCreateInvite: () => {},
    onRevokeInvite: () => {},
    onCopyPrompt: () => {},
  };

  const emptyHtml = renderToStaticMarkup(createElement(SpecialistMcpInviteSlot, { ...baseProps, invites: [] }));
  assert.match(emptyHtml, /specialist-mcp-invite-form/);
  assert.match(emptyHtml, /生成接入链接/);

  const activeHtml = renderToStaticMarkup(createElement(SpecialistMcpInviteSlot, {
    ...baseProps,
    invites: [{
      id: 'inv-1',
      name: '研发预发接入',
      createdAt: '2026-11-27T02:00:00Z',
      expiresAt: '2026-11-28T02:00:00Z',
      status: 'active',
      invitePrompt: '帮我连接 Lake 的「研发预发接入」（发布专员）：http://192.168.50.12:51824/api/gateway/invites/lkiv_abc',
    }],
  }));
  assert.doesNotMatch(activeHtml, /specialist-mcp-invite-form/);
  assert.doesNotMatch(activeHtml, /生成接入链接/);
  assert.match(activeHtml, /研发预发接入/);
  assert.match(activeHtml, /待兑换/);
  assert.match(activeHtml, /撤销/);
  assert.match(activeHtml, /复制接入邀请/);

  const redeemedHtml = renderToStaticMarkup(createElement(SpecialistMcpInviteSlot, {
    ...baseProps,
    invites: [{
      id: 'inv-2',
      name: '研发预发接入',
      createdAt: '2026-11-27T02:00:00Z',
      expiresAt: '2026-11-28T02:00:00Z',
      redeemedAt: '2026-11-27T02:05:00Z',
      status: 'redeemed',
    }],
  }));
  assert.doesNotMatch(redeemedHtml, /specialist-mcp-invite-form/);
  assert.doesNotMatch(redeemedHtml, /生成接入链接/);
  assert.match(redeemedHtml, /已接入/);
  assert.match(redeemedHtml, /撤销并重置/);
});
