import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AgentRun, Resource, SessionSnapshot} from '../../shared/contracts';
import {objectCatalog, objectMatches} from '../src/objectReferences';
import {AssistantMarkdown, ObjectReferencesProvider, ReplyReferenceScope} from '../src/AssistantMarkdown';
import {AITranscript} from '../src/AIPanel';
import {SRECheckpoint, SREProse, SREReport} from '../src/SREReport';

const host: Resource = {id: 'host-testing', projectId: 'project', kind: 'ssh', name: '测试服务器', description: '', status: 'available', ssh: {host: '192.0.2.141', port: 22, username: 'operator'}};
const resources = [host];
const render = (children: string, entries = resources) => renderToStaticMarkup(createElement(ObjectReferencesProvider, {resources: entries, children: createElement(AssistantMarkdown, {children})}));
const at = '2026-10-22T08:00:00Z';
const matches = (text: string, entries = resources) => objectMatches(text, objectCatalog(entries));

test('software names and complete versions render as one inline label in the original sentence', () => {
  const source = '两台数据库的 PostgreSQL 15.8、PostGIS 3.4.3 版本一致，Nginx 1.26.2 正常。';
  const html = render(source);
  assert.equal((html.match(/data-object-kind="software"/g) ?? []).length, 3);
  for (const label of ['PostgreSQL 15.8', 'PostGIS 3.4.3', 'Nginx 1.26.2']) assert.ok(html.includes(`>${label}</span>`), html);
  assert.ok(html.startsWith('<div class="ai-markdown assistant-prose"><p>两台数据库的 '));
  assert.ok(!html.includes('<button'));
  assert.equal(source, '两台数据库的 PostgreSQL 15.8、PostGIS 3.4.3 版本一致，Nginx 1.26.2 正常。');
});

test('unique project resource names and full addresses bind to the same real ID', () => {
  const html = render('测试服务器（192.0.2.141）需要检查，141 只是文字。');
  assert.equal((html.match(/data-object-id="resource:host-testing"/g) ?? []).length, 2);
  assert.equal((html.match(/<button/g) ?? []).length, 2);
  assert.ok(html.includes('141 只是文字'));
  assert.ok(!html.includes('role="dialog"'));
});

test('ambiguous names, shared addresses and missing resources never pick an arbitrary resource', () => {
  const other = {...host, id: 'other-host'};
  assert.deepEqual(matches('测试服务器 192.0.2.141', [host, other]), []);
  assert.deepEqual(matches('测试服务器', []), []);
  const duplicateRedis = [host, other].map(resource => ({...resource, name: 'Redis'}));
  assert.deepEqual(matches('Redis 7.2', duplicateRedis), []);
  assert.equal(matches('Redis 7.2', [{...host, name: 'Redis'}])[0]?.reference.resource?.id, host.id);
});

test('links, URLs, commands, fenced code and identifier substrings remain literal', () => {
  const source = '[PostgreSQL](https://example.test/PostgreSQL)\n\nhttps://example.test/Redis/README.md\n\n`systemctl restart Nginx`\n\n```sh\necho PostgreSQL 15.8\n```\n\nPostgreSQLBackup nginx_worker --Redis /etc/Redis/redis.conf';
  const html = render(source);
  assert.ok(html.includes('href="https://example.test/PostgreSQL"'));
  assert.ok(html.includes('<code>systemctl restart Nginx</code>'));
  const shell = html.match(/<code class="language-sh[^\"]*">([\s\S]*?)<\/code>/)?.[1];
  assert.ok(shell);
  assert.equal(shell.replace(/<\/?span\b[^>]*>/g, ''), 'echo PostgreSQL 15.8\n');
  assert.ok(!shell.includes('data-object-kind'));
  assert.ok(html.includes('PostgreSQLBackup nginx_worker --Redis'));
  assert.ok(!html.includes('data-object-kind="software"'));
  assert.equal(matches('https://example.test/Redis/README.md').length, 0);
  assert.equal(matches('dump/restore').length, 0);
  assert.equal(matches('PostgreSQLBackup /tmp/PostgreSQL.conf').filter(match => match.reference.kind === 'software').length, 0);
});

test('standalone object inline code becomes a reference but configuration names stay code', () => {
  const html = render('`PostgreSQL 15.8`、`测试服务器`、`shared_buffers`、`/etc/nginx/nginx.conf`');
  assert.ok(html.includes('data-object-kind="software"'));
  assert.ok(html.includes('data-object-id="resource:host-testing"'));
  assert.ok(html.includes('<code>shared_buffers</code>'));
  assert.ok(html.includes('data-object-kind="file"'));
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});

test('turn-scoped recorded files can be inspected and ambiguous filenames remain ordinary text', () => {
  const cards = [{id: 'diff', type: 'diff', title: '/srv/nginx.conf', status: 'completed', at, data: {runtime: 'ssh', assetRef: host.id, before: '', after: 'events {}', existed: false}}];
  const html = renderToStaticMarkup(createElement(ObjectReferencesProvider, {resources, children: createElement(ReplyReferenceScope, {cards, children: createElement(AssistantMarkdown, {children: '已更新 `/srv/nginx.conf`。'})})}));
  assert.ok(html.includes('data-object-id="file:'));
  assert.ok(html.includes('<button'));
  assert.ok(!html.includes('events {}'));
  const other = {...cards[0]!, id: 'diff-other', data: {...cards[0]!.data, assetRef: 'other'}};
  const ambiguous = renderToStaticMarkup(createElement(ReplyReferenceScope, {cards: [...cards, other], children: createElement(AssistantMarkdown, {children: '`nginx.conf`'})}));
  assert.ok(ambiguous.includes('<code>nginx.conf</code>'));
  assert.ok(!ambiguous.includes('data-object-kind'));
});

test('known named tasks are references without guessing unnamed tasks or statuses', () => {
  const task = {id: 'task-check', sessionId: 'session', name: '数据库迁移检查', role: 'data', task: '核对版本', resourceIds: [host.id], status: 'completed', createdAt: at} as AgentRun;
  const html = renderToStaticMarkup(createElement(ObjectReferencesProvider, {tasks: [task], children: createElement(AssistantMarkdown, {children: '数据库迁移检查已完成，尚未执行迁移。'})}));
  assert.ok(html.includes('data-object-id="task:task-check"'));
  assert.ok(html.includes('已完成，尚未执行迁移。'));
});

test('snapshot scopes exclude resources from other projects and user input is not decorated', () => {
  const snapshot = {session: {id: 'session', projectId: 'project'}, resources: [host, {...host, id: 'foreign', name: '其他项目主机', projectId: 'foreign'}], messages: [{id: 'user', role: 'user', text: '测试服务器', createdAt: at}], actions: [], evidence: [], ai: {cards: [{id: 'reply', type: 'message', status: 'running', content: '测试服务器运行 PostgreSQL 15.8，其他项目主机不在本项目。', at}], cardsOffset: 0, status: 'running'}} as unknown as SessionSnapshot;
  const html = renderToStaticMarkup(createElement(AITranscript, {snapshot}));
  assert.equal((html.match(/data-object-id="resource:host-testing"/g) ?? []).length, 1);
  assert.ok(!html.includes('data-object-id="resource:foreign"'));
  assert.ok(html.includes('data-object-kind="software"'));
});

test('SRE and ordinary replies share labels and retain long results without automatic folding', () => {
  const body = `测试服务器运行 PostgreSQL 15.8。\n\n### 参数\n\n${'保持完整观察记录。'.repeat(100)}`;
  const html = renderToStaticMarkup(createElement(ObjectReferencesProvider, {resources, children: createElement(SREProse, {compact: true, children: body})}));
  assert.ok(html.includes('data-object-id="resource:host-testing"'));
  assert.ok(html.includes('data-object-kind="software"'));
  assert.ok(!html.includes('<details'));
  assert.ok(html.includes('保持完整观察记录。'.repeat(100)));
  const checkpoint = renderToStaticMarkup(createElement(SRECheckpoint, {body}));
  assert.ok(!checkpoint.includes('<details'));
  const report = renderToStaticMarkup(createElement(SREReport, {compact: true, report: {summary: body, facts: [{statement: 'Nginx 未启动。', evidenceIds: []}], hypotheses: [], unknowns: [], nextChecks: []}, evidence: [], onEvidence: () => {}}));
  assert.ok(!report.includes('<details'));
  assert.ok(report.includes('Nginx'));
});

test('existing session classification tags keep their own identity', () => {
  const html = renderToStaticMarkup(createElement(AssistantMarkdown, {tags: [{id: 'tag', projectId: 'project', name: 'MongoDB', color: 'purple'}], children: 'MongoDB 当前状态'}));
  assert.ok(html.includes('conversation-tag color-purple'));
  assert.ok(!html.includes('data-object-kind="software"'));
});

test('shared rendering preserves code copy, commit copy and explicit fact formatting', () => {
  const html = render('提交：`abc123456789`\n\n测试：12 项测试通过\n\n```sh\necho PostgreSQL\n```');
  assert.ok(html.includes('reply-info-facts'));
  assert.ok(html.includes('复制提交号 abc123456789'));
  assert.ok(html.includes('复制代码'));
  assert.ok(html.includes('markdown-code-command'));
  assert.ok(!html.includes('data-object-kind="software"'));
});
