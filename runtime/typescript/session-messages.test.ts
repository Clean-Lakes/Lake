import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {LakeStore} from './store';

test('existing message archives gain a session index without rewriting history or decoding unrelated conversations', async t => {
  const home = await mkdtemp(join(tmpdir(), 'lake-message-index-')), data = join(home, 'data');
  await mkdir(data);
  const db = new DatabaseSync(join(data, 'lake-typescript.sqlite'));
  db.exec('CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id))');
  const insert = db.prepare('INSERT INTO records VALUES(?,?,?)');
  const message = (id: string, sessionId: string, text: string) => ({id, sessionId, role: 'assistant', text, createdAt: '2026-11-07T00:00:00.000Z'});
  insert.run('messages', 'z-first', JSON.stringify(message('z-first', 'wanted', 'first')));
  for (let i = 0; i < 100; i++) insert.run('messages', 'foreign-' + i, JSON.stringify(message('foreign-' + i, 'other-' + i, 'x'.repeat(8192))));
  insert.run('messages', 'a-second', JSON.stringify(message('a-second', 'wanted', 'second')));
  const before = db.prepare('SELECT kind,id,value FROM records ORDER BY rowid').all(); db.close();
  const store = await LakeStore.open(home, data);
  t.after(async () => {store.close(); await rm(home, {recursive: true, force: true});});
  assert.deepEqual(store.db.prepare('SELECT kind,id,value FROM records ORDER BY rowid').all(), before);
  const list = store.list.bind(store);
  store.list = <T>(kind: string): T[] => {assert.notEqual(kind, 'messages', 'a session read must not deserialize the global message archive'); return list<T>(kind);};
  assert.deepEqual(store.messages('wanted').map(value => [value.id, value.text]), [['z-first', 'first'], ['a-second', 'second']]);
  assert.deepEqual(store.messages('absent'), []);
  const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT value FROM records WHERE kind='messages' AND json_extract(value,'$.sessionId')=? ORDER BY rowid").all('wanted');
  assert.ok(plan.some(row => String(row.detail).includes('messages_by_session')), 'the existing archive must use the session index');
});

test('indexed message reads track edits, reassignments, deletions and restart in original insertion order', async t => {
  const home = await mkdtemp(join(tmpdir(), 'lake-message-updates-')), data = join(home, 'data');
  let store = await LakeStore.open(home, data);
  t.after(async () => {store.close(); await rm(home, {recursive: true, force: true});});
  const project = store.createProject('indexed'), a = store.createSession(project.id), b = store.createSession(project.id);
  const first = store.addMessage(a.id, 'user', 'first'), second = store.addMessage(a.id, 'assistant', 'second');
  const unrelated = store.addMessage(b.id, 'assistant', 'foreign');
  store.put('messages', first.id, {...first, text: 'edited'});
  assert.deepEqual(store.messages(a.id).map(value => value.text), ['edited', 'second']);
  store.put('messages', second.id, {...second, sessionId: b.id});
  assert.deepEqual(store.messages(a.id).map(value => value.id), [first.id]);
  assert.deepEqual(store.messages(b.id).map(value => value.id), [second.id, unrelated.id]);
  store.delete('messages', first.id);
  store.close(); store = await LakeStore.open(home, data);
  assert.deepEqual(store.messages(a.id), []);
  assert.deepEqual(store.snapshot(b.id).messages.map(value => value.id), [second.id, unrelated.id]);
});
