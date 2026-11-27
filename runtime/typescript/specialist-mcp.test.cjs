const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.LAKE_TS_IMPORT_ONLY = '1';
const { startLakeServer } = require('../../bin/lake-runtime/server.cjs');
const { enableNativeSpecialistFixture } = require('./test-fixtures/native-specialists.cjs');

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'lake-specialist-mcp-'));
  const web = join(home, 'web');
  await mkdir(web);
  await writeFile(join(web, 'index.html'), '<html>specialist mcp fixture</html>');
  const app = await startLakeServer({
    home,
    data: join(home, 'data'),
    port: 0,
    staticRoot: web,
    codexHome: join(home, 'codex'),
  });
  enableNativeSpecialistFixture(app.superagent);
  let scheduled = 0;
  app.superagent.schedule = () => { scheduled++; };
  t.after(async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
  });
  const api = async (path, method = 'GET', body, expected = 200, token = app.token) => {
    const response = await fetch(app.origin + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  };

  const project = await api('/api/projects', 'POST', { name: 'HexHub 服务器' });
  const otherProject = await api('/api/projects', 'POST', { name: '其他项目' });
  const role = {
    id: 'release-specialist',
    projectId: project.id,
    roleKey: 'release',
    name: '发布专员',
    duties: '负责预发发布与构建流水线',
    avatarId: 'beaver',
    revision: 1,
    execution: { kind: 'native' },
  };
  app.store.put('superRoles', role.id, role);
  const stagingResource = app.store.put('resources', 'res-gos-staging', {
    id: 'res-gos-staging',
    projectId: project.id,
    name: 'GOS 预发',
    kind: 'ssh',
    description: '预发发布环境',
    status: 'available',
    ssh: { host: 'staging-gos.internal', port: 22, user: 'deploy' },
  });
  const ciResource = app.store.put('resources', 'res-ci-pipeline', {
    id: 'res-ci-pipeline',
    projectId: project.id,
    name: 'CI 构建流水线',
    kind: 'ssh',
    description: 'CI 构建节点',
    status: 'available',
    ssh: { host: 'ci.internal', port: 22, user: 'ci' },
  });
  const prodResource = app.store.put('resources', 'res-gos-prod', {
    id: 'res-gos-prod',
    projectId: project.id,
    name: 'GOS 生产',
    kind: 'ssh',
    description: '生产发布环境',
    status: 'available',
    ssh: { host: 'prod-gos.internal', port: 22, user: 'deploy' },
  });
  const foreignResource = app.store.put('resources', 'res-foreign', {
    id: 'res-foreign',
    projectId: otherProject.id,
    name: '外项目资源',
    kind: 'ssh',
    description: '其他项目资源',
    status: 'available',
  });
  return {
    app,
    api,
    project,
    otherProject,
    role,
    stagingResource,
    ciResource,
    prodResource,
    foreignResource,
    scheduledCount: () => scheduled,
  };
}

test('specialist MCP grants, single-invite enforcement, redemption and revocation enforce project scope', async t => {
  const f = await fixture(t);
  const base = `/api/projects/${f.project.id}/superagent/specialists/${f.role.id}/mcp`;

  const initial = await f.api(base);
  assert.equal(initial.connection, null);
  const initialIds = new Set(initial.resources.map(item => item.id));
  assert.ok(initialIds.has(f.stagingResource.id) && initialIds.has(f.ciResource.id) && initialIds.has(f.prodResource.id));
  assert.equal(initialIds.has(f.foreignResource.id), false);
  assert.ok(initial.remoteEndpoint.endsWith('/api/gateway/mcp'));

  // Creating an invite before confirming grants is rejected.
  await f.api(`${base}/invites`, 'POST', { name: '研发预发发布接入' }, 409);

  // Cross-project resources cannot be granted.
  await f.api(`${base}/grants`, 'PUT', {
    resourceGrants: [{ resourceId: f.foreignResource.id }],
  }, 400);

  // Confirm resource grants without approvalPolicy (and verify legacy approvalPolicy remains accepted).
  const saved = await f.api(`${base}/grants`, 'PUT', {
    resourceGrants: [
      { resourceId: f.stagingResource.id },
      { resourceId: f.ciResource.id, approvalPolicy: 'always_approve' },
    ],
  });
  assert.ok(saved.connection);
  assert.equal(saved.connection.enabled, true);
  assert.equal(saved.connection.resourceGrants.length, 2);

  // Create and inspect a one-time invite with custom name, then verify duplicate creation is blocked.
  const { invite, state: afterFirstCreate } = await f.api(`${base}/invites`, 'POST', { name: '研发预发发布接入', ttlMinutes: 15 }, 201);
  assert.equal(invite.status, 'active');
  assert.equal(invite.name, '研发预发发布接入');
  assert.equal(afterFirstCreate.invites.length, 1);
  assert.match(invite.invitePrompt, /帮我连接 Lake 的「研发预发发布接入」（发布专员）：/);
  assert.doesNotMatch(invite.invitePrompt, /WorkBuddy/i);
  const inviteUrl = new URL(invite.inviteUrl);
  assert.notEqual(inviteUrl.hostname, 'localhost', 'invite URL should use LAN IPv4 when available');

  // A specialist can only have one invite link; duplicate creation while active must be rejected.
  const dupActive = await f.api(`${base}/invites`, 'POST', { name: '重复链接' }, 409);
  assert.match(dupActive.error, /不能重复创建/);

  const inspectedResponse = await fetch(invite.inviteUrl);
  assert.equal(inspectedResponse.status, 200);
  const inspected = await inspectedResponse.json();
  assert.equal(inspected.status, 'active');
  assert.equal(inspected.name, '研发预发发布接入');
  assert.equal(inspected.resourceCount, 2);
  assert.equal(inspected.transport, 'streamable-http');

  const redeemedResponse = await fetch(inspected.redeemUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(redeemedResponse.status, 200);
  const redeemed = await redeemedResponse.json();
  assert.ok(redeemed.token.startsWith('lkgw_'));
  assert.equal(redeemed.inviteName, '研发预发发布接入');
  assert.equal(redeemed.transport, 'streamable-http');
  assert.equal(redeemed.resourceGrants.length, 2);

  // Verify the LAN MCP endpoint responds to JSON-RPC initialize & rejects non-gateway paths.
  const lanMcpResp = await fetch(redeemed.mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${redeemed.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
  });
  assert.equal(lanMcpResp.status, 200);
  const lanMcpInit = await lanMcpResp.json();
  assert.equal(lanMcpInit.result.serverInfo.name, 'lake-remote-mcp');
  const blockedUiResp = await fetch(`${inviteUrl.origin}/api/projects`);
  assert.equal(blockedUiResp.status, 404);

  // Single-use invite cannot be redeemed a second time.
  const secondRedeem = await fetch(inspected.redeemUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(secondRedeem.status, 410);

  // Duplicate creation while an existing invite is redeemed is also blocked until revoked.
  const dupRedeemed = await f.api(`${base}/invites`, 'POST', { name: '第二个链接' }, 409);
  assert.match(dupRedeemed.error, /不能重复创建/);

  // Revoking the redeemed invite rotates the connection bearer token and unlocks creating one replacement invite.
  await f.api(`${base}/invites/${invite.id}`, 'DELETE');
  const staleTokenResp = await fetch(redeemed.mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${redeemed.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
  });
  assert.equal(staleTokenResp.status, 401);

  // Now creating a single replacement invite succeeds, and revoking it blocks redemption.
  const second = await f.api(`${base}/invites`, 'POST', { name: '临时测试链接' }, 201);
  assert.equal(second.state.invites.length, 1);
  assert.equal(second.state.invites[0].id, second.invite.id);
  const secondToken = second.invite.inviteUrl.split('/').at(-1);
  await f.api(`${base}/invites/${second.invite.id}`, 'DELETE');
  await f.api(`/api/gateway/invites/${secondToken}/redeem`, 'POST', {}, 410, '');
});

test('Streamable HTTP MCP blocks unauthorized resources and delivers scoped messages as proactive specialist notifications in Lake', async t => {
  const f = await fixture(t);
  const base = `/api/projects/${f.project.id}/superagent/specialists/${f.role.id}/mcp`;

  await f.api(`${base}/grants`, 'PUT', {
    resourceGrants: [
      { resourceId: f.stagingResource.id },
      { resourceId: f.ciResource.id },
    ],
  });
  const { invite } = await f.api(`${base}/invites`, 'POST', { name: '研发预发接入' }, 201);
  const inviteToken = invite.inviteUrl.split('/').at(-1);
  const { token } = await f.api(`/api/gateway/invites/${inviteToken}/redeem`, 'POST', {}, 200, '');

  const rpc = (method, params = {}, id = 1) =>
    f.api('/api/gateway/mcp', 'POST', { jsonrpc: '2.0', id, method, params }, 200, token);

  const init = await rpc('initialize', { protocolVersion: '2025-03-26' });
  assert.equal(init.result.serverInfo.name, 'lake-remote-mcp');
  const tools = await rpc('tools/list');
  assert.deepEqual(tools.result.tools.map(item => item.name), ['send_message', 'get_message_status', 'wait_message', 'test_connection']);

  // Request referencing unauthorized production resource is intercepted before reaching Lake.
  const blocked = await rpc('tools/call', {
    name: 'send_message',
    arguments: {
      text: '帮我把订单服务发布到 GOS 生产 v2.14.3',
      thread_id: 'mcp-thread-prod',
      client_message_id: 'mcp-msg-prod-0001',
    },
  });
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.result.content[0].text, /未授权资源.*GOS 生产/);
  assert.equal(f.scheduledCount(), 0);

  // Scoped request dispatches directly without approval gate and posts a specialist notification in Lake main chat.
  const deployCall = await rpc('tools/call', {
    name: 'send_message',
    arguments: {
      text: '帮我把订单服务发布到 GOS 预发，版本 v2.14.3-rc2，发完确认服务健康状态',
      thread_id: 'mcp-thread-deploy',
      client_message_id: 'mcp-msg-deploy-0001',
    },
  });
  assert.notEqual(deployCall.result.isError, true);
  const deployPayload = JSON.parse(deployCall.result.content[0].text);
  assert.equal(deployPayload.approvalId, undefined);
  assert.equal(f.scheduledCount(), 1, 'scoped external request should schedule immediately without pre-approval');

  const ws = await f.api(`/api/projects/${f.project.id}/superagent`);
  assert.equal(ws.gatewayApprovals, undefined);

  // Verify Lake main chat message carries proactive specialistNotice metadata and exact scoped resource reference.
  const message = f.app.store.get('messages', deployPayload.instructionId);
  assert.ok(message);
  assert.equal(message.sessionId, ws.project.routerSessionId);
  assert.equal(message.external.connectionName, '发布专员 MCP');
  assert.equal(message.external.specialistNotice.roleId, f.role.id);
  assert.equal(message.external.specialistNotice.roleName, '发布专员');
  assert.equal(message.external.specialistNotice.avatarId, 'beaver');
  assert.deepEqual(message.external.specialistNotice.resourceNames, ['GOS 预发']);
  assert.deepEqual(f.app.store.get('messageInputs', deployPayload.instructionId).resourceIds, [f.stagingResource.id]);

  // Status reports routing (not waiting_approval).
  const status = JSON.parse((await rpc('tools/call', {
    name: 'get_message_status',
    arguments: { message_id: deployPayload.instructionId },
  })).result.content[0].text);
  assert.equal(status.state, 'routing');
  assert.equal(status.approval, undefined);
});

test('bulk specialist grants stay scoped without listing all 320 resources on the Lake notification', async t => {
  const f = await fixture(t);
  const base = `/api/projects/${f.project.id}/superagent/specialists/${f.role.id}/mcp`;
  const grants = [];
  for (let i = 0; i < 320; i++) {
    const rid = `res-bulk-${i}`;
    f.app.store.put('resources', rid, {
      id: rid,
      projectId: f.project.id,
      name: `主机-${i}`,
      kind: 'ssh',
      description: '批量主机',
      status: 'available',
    });
    grants.push({ resourceId: rid });
  }
  const saved = await f.api(`${base}/grants`, 'PUT', { resourceGrants: grants });
  assert.equal(saved.connection.resourceGrants.length, 320);

  const { invite } = await f.api(`${base}/invites`, 'POST', {}, 201);
  const { token } = await f.api(`/api/gateway/invites/${invite.inviteUrl.split('/').at(-1)}/redeem`, 'POST', {}, 200, '');
  const sent = await f.api('/api/gateway/messages', 'POST', {
    text: '请用文字说明你支持的内容类型和发布能力',
    threadId: 'bulk-grants',
    clientMessageId: 'bulk-grants-message-1',
  }, 202, token);

  assert.equal(f.scheduledCount(), 1);
  const message = f.app.store.get('messages', sent.instructionId);
  assert.equal(message.external.specialistNotice.roleName, '发布专员');
  assert.equal(message.external.specialistNotice.resourceNames, undefined);
  assert.equal(f.app.store.get('messageInputs', sent.instructionId).resourceIds.length, 320);
});

test('expired specialist resource grants block external MCP messages', async t => {
  const f = await fixture(t);
  const base = `/api/projects/${f.project.id}/superagent/specialists/${f.role.id}/mcp`;
  await f.api(`${base}/grants`, 'PUT', {
    resourceGrants: [{ resourceId: f.stagingResource.id, expiresAt: '2020-01-01T00:00:00.000Z' }],
  });
  const { invite } = await f.api(`${base}/invites`, 'POST', {}, 201);
  const { token } = await f.api(`/api/gateway/invites/${invite.inviteUrl.split('/').at(-1)}/redeem`, 'POST', {}, 200, '');
  const denied = await f.api('/api/gateway/messages', 'POST', {
    text: '检查 GOS 预发服务状态',
    threadId: 'expired-grant',
    clientMessageId: 'expired-grant-msg-1',
  }, 403, token);
  assert.match(denied.error, /暂无有效授权资源或授权已过期/);
  assert.equal(f.scheduledCount(), 0);
});
