#!/usr/bin/env node
// Runs the installed, unmodified ZCode Agent against a loopback model fixture.
// Real SSH is opt-in and limited to one hostname check on an authorized host.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lakeBin = join(repo, 'bin/lake');
const zcodeCLI = process.env.LAKE_PROBE_ZCODE_CLI || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const builtinPath = process.env.LAKE_PROBE_ZCODE_BUILTIN || '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json';
const real = process.argv.includes('--real');
const lakeName = process.env.LAKE_PROBE_LAKE || '测试湖';
const reportRoot = join(homedir(), 'Library/Application Support/Lake/test-reports', `zcode-ops-${Date.now()}`);
await mkdir(reportRoot, { recursive: true, mode: 0o700 });
const fixtureHome = join(reportRoot, 'fixture-lake');
const lakeHome = real ? (process.env.LAKE_HOME || join(homedir(), '.lake')) : fixtureHome;
const cli = (args, root = lakeHome) => JSON.parse(execFileSync(lakeBin, args, { env: { ...process.env, LAKE_HOME: root }, encoding: 'utf8' }));
if (!real) {
  cli(['add', lakeName, '--json']);
  cli(['res', 'add', `${lakeName}/fixture-host`, '--ssh', 'fixture@127.0.0.1:9', '--json']);
  cli(['res', 'authz', `${lakeName}/fixture-host`, 'on', '--json']);
}
const resources = cli(['res', 'ls', '--lake', lakeName, '--json']);
const target = resources.find(r => r.kind === 'host' && (!real || r.execute_authz));
assert(target, 'No suitable registered host');
if (real) assert(cli(['permissions', '--json']).silent_ssh_read, 'Real probe requires existing silent read policy; it never changes global permissions');

const toolNames = ['lake_lakes', 'lake_resources', 'lake_ssh_read', 'lake_journal'].map(n => `mcp__lakeprobe__${n}`);
const deniedTools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'TodoWrite', 'TodoRead', 'ReadSessionContext', 'Skill', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'TaskOutput', 'TaskStop', 'NotebookEdit', 'MultiEdit', 'NodeRepl', 'js', 'ListMcpResources', 'ReadMcpResource', 'CronCreate', 'CronDelete', 'CronList', 'CronUpdate', 'mcp__node_repl__js'];
const evidence = { realSSH: real, zcodeCLI, cases: [], modelRequests: 0, unexpectedModelRequests: 0 };

function collectResults(body) {
  const results = [];
  for (const msg of body.messages || []) {
    if (msg.role !== 'tool') continue;
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    try { results.push(JSON.parse(content)); } catch { results.push({ text: content }); }
  }
  return results;
}
function findNested(value, predicate) {
  if (value && typeof value === 'object') {
    if (predicate(value)) return value;
    for (const child of Object.values(value)) { const found = findNested(child, predicate); if (found) return found; }
  }
  if (typeof value === 'string') {
    const candidates = [value, value.split('Structured content:\n').at(-1), ...value.split('\n')];
    for (const candidate of candidates) {
      if (candidate.startsWith('{') || candidate.startsWith('[')) {
        try { const found = findNested(JSON.parse(candidate), predicate); if (found) return found; } catch {}
      }
    }
  }
}
let activeCase;
const mock = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    const body = JSON.parse(raw);
    evidence.modelRequests++;
    if (!req.url.endsWith('/chat/completions')) throw new Error('Unexpected model route');
    const available = body.tools?.map(t => t.function.name) || [];
    // The runtime must not offer Shell, file access, or unrelated MCP servers.
    activeCase.visibleTools = available;
    assert(available.length > 0 && available.every(n => toolNames.includes(n)), `Unexpected tools: ${available.join(',')}`);
    const results = collectResults(body);
    if (results.length >= 1) activeCase.lakesResult = findNested(results[0], v => Array.isArray(v.lakes));
    if (results.length >= 2) activeCase.resourcesResult = findNested(results[1], v => Array.isArray(v.hosts));
    let name, args;
    if (results.length === 0) { name = toolNames[0]; args = {}; }
    else if (results.length === 1) { name = toolNames[1]; args = {}; }
    else if (results.length === 2) { name = toolNames[2]; args = { resource_id: target.id, check: 'hostname' }; }
    else if (results.length === 3) {
      const read = findNested(results.at(-1), v => typeof v.run_id === 'string');
      activeCase.readResult = read || results.at(-1);
      if (read) { name = toolNames[3]; args = { run_id: read.run_id }; }
    }
    if (results.length >= 4) activeCase.journalResult = findNested(results.at(-1), v => Array.isArray(v.events));
    const finish = !name;
    const text = finish ? 'LAKE_PROBE_DONE' : '';
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const base = { id: `fixture-${randomUUID()}`, object: 'chat.completion.chunk', created: 1, model: 'probe-model' };
      const send = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
      send({ role: 'assistant', ...(finish ? { content: text } : { tool_calls: [{ index: 0, id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) });
      send({}, finish ? 'stop' : 'tool_calls');
      res.write('data: [DONE]\n\n'); res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `fixture-${randomUUID()}`, object: 'chat.completion', created: 1, model: 'probe-model', choices: [{ index: 0, message: { role: 'assistant', content: finish ? text : null, ...(finish ? {} : { tool_calls: [{ id: `call_${randomUUID()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) }, finish_reason: finish ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
    }
  } catch (err) {
    evidence.unexpectedModelRequests++;
    activeCase.modelError = err.message;
    res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } }));
  }
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const modelURL = `http://127.0.0.1:${mock.address().port}/v1`;

class Protocol {
  constructor(child, test) {
    this.child = child; this.test = test; this.nextID = 1; this.pending = new Map(); this.events = []; this.stderr = '';
    createInterface({ input: child.stdout }).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { this.events.push({ nonProtocolOutput: line.slice(0, 200) }); return; }
      this.events.push(message);
      if (message.id !== undefined && message.method) {
        if (message.method === 'interaction/requestPermission') {
          test.permissions.push(message.params);
          const denied = test.denyNative && JSON.stringify(message.params).includes('lake_ssh_read');
          if (denied) test.nativeReadDenied = true;
          child.stdin.write(JSON.stringify({ id: message.id, result: { decision: denied ? 'deny' : 'allow', reason: 'Explicit integration test decision' } }) + '\n');
        } else {
          child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported host request in probe' } }) + '\n');
        }
      } else if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
      }
    });
    child.stderr.on('data', chunk => { this.stderr += chunk; });
    child.on('exit', (code, signal) => { for (const p of this.pending.values()) p.reject(new Error(`ZCode exited ${code}/${signal}`)); this.pending.clear(); });
  }
  call(method, params) {
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 45000);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
}

try {
  for (const spec of [
    { name: 'zcode-native-approval-denied', requireApproval: false, denyNative: true },
    { name: 'lake-server-approval-required', requireApproval: true, denyNative: false },
    ...(real ? [{ name: 'real-hostname-existing-policy', requireApproval: false, denyNative: false }] : []),
  ]) {
    activeCase = { ...spec, permissions: [] }; evidence.cases.push(activeCase);
    const runRoot = join(reportRoot, spec.name), workspace = join(runRoot, 'workspace');
    await mkdir(join(workspace, '.zcode'), { recursive: true, mode: 0o700 });
    const builtin = JSON.parse(await readFile(builtinPath, 'utf8'));
    builtin.config.providerConfigRules = { templateRules: [], providerRules: [{ providerId: 'probe', providerName: 'Local integration fixture', config: { group: 'zai-family', access: { type: 'api-key', apiKey: 'fixture-not-a-real-key' }, api: { type: 'openai-chat-completions', baseUrl: modelURL }, builtinModelIds: ['probe-model'] } }] };
    const localBuiltin = join(runRoot, 'builtin.json'), personal = join(runRoot, 'personal.json');
    await writeFile(localBuiltin, JSON.stringify(builtin), { mode: 0o600 });
    await writeFile(personal, JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }, defaultModelSelection: { providerId: 'probe', modelId: 'probe-model', options: { reasoningLevel: 'disabled' } } } }), { mode: 0o600 });
    await writeFile(join(workspace, '.zcode/config.json'), JSON.stringify({ features: { memory: false, subagent: false, skill: false, mcp: true }, memory: { use: false }, permission: { mode: 'build' }, mcp: { servers: {} } }), { mode: 0o600 });
    const child = spawn(process.execPath, [zcodeCLI, 'app-server', '--cwd', workspace, '--surface', 'desktop'], {
      cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, NODE_ENV: 'production', ZCODE_DATA_BASE_DIR: runRoot, ZCODE_STORAGE_DIR: join(runRoot, 'storage'), ZCODE_SESSION_DB_PATH: join(runRoot, 'sessions.sqlite'), ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: localBuiltin, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal },
    });
    const protocol = new Protocol(child, activeCase);
    try {
      const created = await protocol.call('session/create', {
        workspace: { workspacePath: workspace, workspaceKey: workspace }, mode: 'build',
        model: { providerId: 'probe', modelId: 'probe-model', options: { reasoningLevel: 'disabled' } }, titleGenerationEnabled: false,
        mcpServers: [{ name: 'lakeprobe', command: lakeBin, args: ['ops-mcp', '--lake', lakeName, `--require-approval=${spec.requireApproval}`], env: [{ name: 'LAKE_HOME', value: lakeHome }], protocolVersion: 'legacy', timeoutMs: 90000 }],
        toolDenylist: deniedTools,
      });
      activeCase.createResult = created;
      const sessionID = created.session?.sessionId || created.session?.id || created.sessionId;
      assert(sessionID, `Missing session ID; result keys: ${Object.keys(created)}`);
      await protocol.call('session/subscribe', { sessionId: sessionID, deliveryKind: 'desktop-continuous' });
      activeCase.sendResult = await protocol.call('session/send', { sessionId: sessionID, content: 'Integration fixture: choose the bound lake, list its hosts, run exactly one hostname check on the listed target, read the correlated journal, then finish. Never retry a denied check.', modelSelection: { providerId: 'probe', modelId: 'probe-model', options: { reasoningLevel: 'disabled' } }, modelExecution: { selectionScope: 'execution', memoryExtraction: 'skip' } });
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline && !activeCase.modelError && !protocol.events.some(e => JSON.stringify(e).includes('LAKE_PROBE_DONE'))) await new Promise(resolve => setTimeout(resolve, 100));
      if (activeCase.modelError) throw new Error(activeCase.modelError);
      activeCase.finished = protocol.events.some(e => JSON.stringify(e).includes('LAKE_PROBE_DONE'));
      activeCase.finalSession = await protocol.call('session/read', { sessionId: sessionID });
      assert(activeCase.finished, 'Agent did not finish probe');
      assert.deepEqual(activeCase.lakesResult?.lakes?.map(l => l.name), [lakeName]);
      const visibleHosts = activeCase.resourcesResult?.hosts || [];
      assert.deepEqual(visibleHosts.map(h => h.id).sort(), resources.filter(r => r.kind === 'host').map(r => r.id).sort());
      assert(activeCase.permissions.some(p => p.toolName === toolNames[2]), 'Native tool permission did not occur');
      if (spec.denyNative) {
        assert(activeCase.nativeReadDenied, 'Native denial was not submitted');
        assert(!activeCase.readResult?.run_id, 'Native-denied tool reached LAKE executor');
      } else if (spec.requireApproval) {
        assert.equal(activeCase.readResult?.status, 'failed');
        assert.match(activeCase.readResult.error, /MCP 审批/);
        assert(activeCase.journalResult?.events.some(e => e.event === 'denied'));
        assert(!activeCase.journalResult.events.some(e => e.event === 'started' || e.event === 'completed'));
      } else {
        assert.equal(activeCase.readResult?.status, 'completed');
        assert.equal(activeCase.readResult?.exit_code, 0);
        assert(activeCase.readResult.stdout.trim(), 'Hostname was empty');
        const events = activeCase.journalResult?.events || [];
        assert.equal(events.filter(e => e.event === 'started').length, 1);
        assert.equal(events.filter(e => e.event === 'completed').length, 1);
        assert.equal(new Set(events.map(e => e.action_id)).size, 1);
        const independent = cli(['journal', '--tail', '--limit', '1000', '--json']).filter(e => e.run_id === activeCase.readResult.run_id);
        assert.equal(independent.filter(e => e.event === 'completed').length, 1);
        assert(independent.every(e => e.target_path === `${lakeName}/${target.name}`));
        activeCase.independentAudit = independent;
      }
      activeCase.verified = true;
    } catch (error) { activeCase.error = error.message; }
    finally {
      child.stdin.end();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 2000))]);
      await writeFile(join(runRoot, 'protocol.json'), JSON.stringify(protocol.events, null, 2), { mode: 0o600 });
      await writeFile(join(runRoot, 'stderr.log'), protocol.stderr, { mode: 0o600 });
    }
    console.log(JSON.stringify({ case: spec.name, verified: activeCase.verified || false, permissions: activeCase.permissions.length, error: activeCase.error || activeCase.modelError || null, readStatus: activeCase.readResult?.status }));
    if (activeCase.error) break;
  }
} finally {
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  await writeFile(join(reportRoot, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(`Private evidence: ${reportRoot}`);
}
if (evidence.cases.some(c => c.error || c.modelError || !c.finished)) process.exitCode = 1;
