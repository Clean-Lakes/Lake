// Real App against fictional in-memory data. Never connects to a Lake backend,
// the running Dev app, model providers or remote resources.
import './composer-model-workbench';
import type {SessionSnapshot, WorkSession} from '../../../shared/contracts';

const original = window.fetch.bind(window);
const resolved = new Set<string>();
let sessions: WorkSession[] = [];
const requests: unknown[] = [];
const proof = document.createElement('output'); proof.id = 'session-issue-proof'; proof.hidden = true;
document.body.appendChild(proof);
const releases: Array<() => void> = [];
document.addEventListener('keydown', event => {if (event.key === 'F8') {event.preventDefault(); releases.shift()?.();}});
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
  if (init?.method === 'POST' && (url.pathname.endsWith('/messages') || url.pathname.endsWith('/ai/resolveOperation'))) {
    const payload = JSON.parse(String(init.body));
    requests.push({path: url.pathname, payload}); proof.textContent = JSON.stringify(requests);
    if (url.pathname.endsWith('/messages') && new URLSearchParams(location.search).has('fail-send')) return json({error: '隔离测试：发送失败，请重试'}, 503);
    if (url.pathname.endsWith('/messages') && new URLSearchParams(location.search).has('slow-send')) await new Promise<void>(resolve => releases.push(resolve));
    if (url.pathname.endsWith('/ai/resolveOperation')) resolved.add(url.pathname.split('/')[3]!);
    return json({});
  }
  const response = await original(input, init);
  if (url.pathname === '/api/catalog') {
    const catalog = await response.json(); sessions = catalog.sessions;
    return json(catalog);
  }
  if (url.pathname.endsWith('/snapshot')) {
    const snapshot: SessionSnapshot = await response.json();
    const id = url.pathname.split('/')[3]!;
    snapshot.session = {...snapshot.session, ...sessions.find(session => session.id === id), id, status: 'completed'};
    snapshot.messages = [{id: 'fixture-user', sessionId: id, role: 'user', text: '检查隔离测试记录', createdAt: '2026-10-20T23:59:00Z'}];
    snapshot.sre = {enabled: false, tasks: []};
    snapshot.actions = [];
    snapshot.ai = {...snapshot.ai!, status: 'completed', question: undefined, pending: undefined, pendingApprovals: [], agentRuns: [], cards: [{id: 'sections', type: 'message', status: 'completed', at: '2026-10-21T00:00:00Z', content: 'PLAN.md：§0 资源规格，§5.4 验收门禁。代码 `§1` 保留原样。'}],
      operationOutcomes: resolved.has(id) ? [] : [{id: `original-${id}`, tool: 'append', target: '隔离测试文件', status: 'unknown', result: '测试记录：等待核实原文件内容', startedAt: '2026-10-21T00:00:00Z'}]};
    return json(snapshot);
  }
  return response;
};
