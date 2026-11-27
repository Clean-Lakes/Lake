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

test('specialist MCP grants, single-use invite redemption and revocation enforce project scope', async t => {
  const f = await fixture(t);
  const base = `/api/projects/${f.project.id}/superagent/specialists/${f.role.id}/mcp`;

  const initial = await f.api(base);
  assert.equal(initial.connection, null);
  const initialIds = new Set(initial.resources.map(item => item.id));
  assert.ok(initialIds.has(f.stagingResource.id) && initialIds.has(f.ciResource.id) && initialIds.has(f.prodResource.id));
  assert.equal(initialIds.has(f.foreignResource.id), false);
  assert.ok(initial.remoteEndpoint.endsWith('/api/gateway/mcp'));

  // Creating an invite before confirming grants is rejected.
  await f.api(`${base}/invites`, 'POST', { recipient: '林明' }, 409);

  // Cross-project resources cannot be granted.
  await f.api(`${base}/grants`, 'PUT', {
    resourceGrants: [{ resourceId: f.foreignResource.id, approvalPolicy: 'always_approve' }],
  }, 400);

  // Confirm resource grants for staging + CI.
  const saved = await f.api(`${base}/grants`, 'PUT', {
    resourceGrants: [
      { resourceId: f.stagingResource.id, approvalPolicy: 'always_approve' },
      { resourceId: f.ciResource.id, approvalPolicy: 'always_approve' },
    ],
  });
  assert.ok(saved.connection);
  assert.equal(saved.connection.enabled, true);
  assert.equal(saved.connection.resourceGrants.length, 2);

  // Create and inspect a one-time invite with custom name, then redeem it over its actual endpoint URL.
  const { invite } = await f.api(`${base}/invites`, 'POST', { name: '研发预发发布接入', ttlMinutes: 15 }, 201);
  assert.equal(invite.status, 'active');
  assert.equal(invite.name, '研发预发发布接入');
  assert.match(invite.invitePrompt, /帮我连接 Lake 的「研发预发发布接入」（发布专员）：/);
  assert.doesNotMatch(invite.invitePrompt, /WorkBuddy/i);
  const inviteUrl = new URL(invite.inviteUrl);
  assert.notEqual(inviteUrl.hostname, 'localhost', 'invite URL should use LAN IPv4 when available');

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

  // Verify the LAN MCP endpoint actually responds to JSON-RPC initialize & rejects non-gateway paths.
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

  // Revoked invite cannot be redeemed.
  const second = await f.api(`${base}/invites`, 'POST', { name: '临时测试链接' }, 201);
  const secondToken = second.invite.inviteUrl.split('/').at(-1);
  await f.api(`${base}/invites/${second.invite.id}`, 'DELETE');
  await f.api(`/api/gateway/invites/${secondToken}/redeem`, 'POST', {}, 410, '');
});

test('Streamable HTTP MCP creates dynamic approval cards, blocks unauthorized resources, and enforces approve/reject decisions', async t => {
  const f = await fixture(t);
  const base = `/api/projects/${f.project.id}/superagent/specialists/${f.role.id}/mcp`;

  await f.api(`${base}/grants`, 'PUT', {
    resourceGrants: [
      { resourceId: f.stagingResource.id, approvalPolicy: 'always_approve' },
      { resourceId: f.ciResource.id, approvalPolicy: 'always_approve' },
    ],
  });
  const { invite } = await f.api(`${base}/invites`, 'POST', { recipient: '林明' }, 201);
  const inviteToken = invite.inviteUrl.split('/').at(-1);
  const { token } = await f.api(`/api/gateway/invites/${inviteToken}/redeem`, 'POST', {}, 200, '');

  const rpc = (method, params = {}, id = 1) =>
    f.api('/api/gateway/mcp', 'POST', { jsonrpc: '2.0', id, method, params }, 200, token);

  const init = await rpc('initialize', { protocolVersion: '2025-03-26' });
  assert.equal(init.result.serverInfo.name, 'lake-remote-mcp');
  const tools = await rpc('tools/list');
  assert.deepEqual(tools.result.tools.map(item => item.name), ['send_message', 'get_message_status', 'wait_message', 'test_connection']);

  // Request referencing unauthorized production resource is intercepted.
  const blocked = await rpc('tools/call', {
    name: 'send_message',
    arguments: {
      text: '帮我把订单服务发布到 GOS 生产 v2.14.3',
      thread_id: 'wb-thread-prod',
      client_message_id: 'wb-msg-prod-0001',
    },
  });
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.result.content[0].text, /未授权资源.*GOS 生产/);

  // 1) Staging deploy request generates deploy-specific dynamic fields and waits for approval.
  const deployCall = await rpc('tools/call', {
    name: 'send_message',
    arguments: {
      text: '帮我把订单服务发布到 GOS 预发，版本 v2.14.3-rc2，发完确认服务健康状态',
      thread_id: 'wb-thread-deploy',
      client_message_id: 'wb-msg-deploy-0001',
    },
  });
  assert.notEqual(deployCall.result.isError, true);
  const deployPayload = JSON.parse(deployCall.result.content[0].text);
  assert.ok(deployPayload.approvalId);
  assert.equal(f.scheduledCount(), 0, 'unapproved external request must not schedule execution');

  // 2) CI rebuild request generates different dynamic fields (pipeline/build/branch).
  const rebuildCall = await rpc('tools/call', {
    name: 'send_message',
    arguments: {
      text: '麻烦帮我重跑 pay-gateway-ci 的 #4821，分支 release/2.14',
      thread_id: 'wb-thread-ci',
      client_message_id: 'wb-msg-ci-0001',
    },
  });
  const rebuildPayload = JSON.parse(rebuildCall.result.content[0].text);
  assert.ok(rebuildPayload.approvalId);

  const ws = await f.api(`/api/projects/${f.project.id}/superagent`);
  assert.equal(ws.gatewayApprovals.length, 2);
  const deployApproval = ws.gatewayApprovals.find(item => item.id === deployPayload.approvalId);
  const rebuildApproval = ws.gatewayApprovals.find(item => item.id === rebuildPayload.approvalId);
  assert.equal(deployApproval.status, 'pending');
  assert.ok(deployApproval.fields.some(field => field.label === '发布目标' && field.value.includes('订单服务')));
  assert.ok(deployApproval.fields.some(field => field.label === '目标版本' && field.value === 'v2.14.3-rc2'));
  assert.ok(rebuildApproval.fields.some(field => field.label === '流水线' && field.value === 'pay-gateway-ci'));
  assert.ok(rebuildApproval.fields.some(field => field.label === '构建编号' && field.value === '#4821'));
  assert.ok(rebuildApproval.fields.some(field => field.label === '目标分支' && field.value === 'release/2.14'));
  assert.notDeepEqual(deployApproval.fields.map(x => x.label), rebuildApproval.fields.map(x => x.label));

  // External status reports waiting_approval before admin decides.
  const waitingStatus = await rpc('tools/call', {
    name: 'get_message_status',
    arguments: { message_id: deployPayload.instructionId },
  });
  assert.equal(JSON.parse(waitingStatus.result.content[0].text).state, 'waiting_approval');

  // Reject CI rebuild with an explicit reason and confirm caller receives it.
  const rejected = await f.api(
    `/api/projects/${f.project.id}/superagent/gateway-approvals/${rebuildApproval.id}/decision`,
    'POST',
    { approve: false, reason: '当前封板窗口，14:00 后再重跑' },
  );
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.decisionReason, '当前封板窗口，14:00 后再重跑');
  assert.equal(f.scheduledCount(), 0);
  const rejectedStatus = JSON.parse((await rpc('tools/call', {
    name: 'get_message_status',
    arguments: { message_id: rebuildPayload.instructionId },
  })).result.content[0].text);
  assert.equal(rejectedStatus.state, 'stopped');
  assert.ok(rejectedStatus.replies.some(reply => reply.text.includes('当前封板窗口')));

  // Approve staging deploy -> creates user message with bound resourceIds and schedules execution.
  const approved = await f.api(
    `/api/projects/${f.project.id}/superagent/gateway-approvals/${deployApproval.id}/decision`,
    'POST',
    { approve: true },
  );
  assert.equal(approved.status, 'approved');
  assert.equal(f.scheduledCount(), 1);
  assert.ok(f.app.store.get('messages', deployPayload.instructionId));
});

test('auto_in_scope resource grant routes directly without manual approval card while staying scoped', async t => {
  const f = await fixture(t);
  const base = `/api/projects/${f.project.id}/superagent/specialists/${f.role.id}/mcp`;

  await f.api(`${base}/grants`, 'PUT', {
    resourceGrants: [{ resourceId: f.stagingResource.id, approvalPolicy: 'auto_in_scope' }],
  });
  const { invite } = await f.api(`${base}/invites`, 'POST', { recipient: '自动发布测试' }, 201);
  const { token } = await f.api(`/api/gateway/invites/${invite.inviteUrl.split('/').at(-1)}/redeem`, 'POST', {}, 200, '');

  const sent = await f.api('/api/gateway/messages', 'POST', {
    text: '检查 GOS 预发服务状态',
    threadId: 'wb-auto-1',
    clientMessageId: 'wb-auto-msg-0001',
  }, 202, token);
  assert.equal(sent.approvalId, undefined);
  assert.equal(f.scheduledCount(), 1);
  const ws = await f.api(`/api/projects/${f.project.id}/superagent`);
  assert.equal(ws.gatewayApprovals.length, 0);
});

test('specialist MCP resource grants scale beyond 256 project resources cleanly', async t => {
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
    grants.push({ resourceId: rid, approvalPolicy: 'always_approve' });
  }
  const saved = await f.api(`${base}/grants`, 'PUT', { resourceGrants: grants });
  assert.equal(saved.connection.resourceGrants.length, 320);
});
