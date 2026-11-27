import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {HttpError, LakeStore} from './store';

test('renameProject updates and trims the project name across restarts while preserving other fields', async t => {
  const home = await mkdtemp(join(tmpdir(), 'lake-project-rename-')), data = join(home, 'data');
  let store = await LakeStore.open(home, data);
  t.after(async () => {store.close(); await rm(home, {recursive: true, force: true});});

  const created = store.createProject('初始项目');
  const renamed = store.renameProject(created.id, '  新项目名称  ');
  assert.equal(renamed.id, created.id);
  assert.equal(renamed.name, '新项目名称');
  assert.equal(renamed.createdAt, created.createdAt);
  assert.deepEqual(store.catalog().projects.map(p => p.name), ['新项目名称']);

  store.close();
  store = await LakeStore.open(home, data);
  assert.equal(store.project(created.id).name, '新项目名称');
  assert.deepEqual(store.catalog().projects.map(p => p.name), ['新项目名称']);
});

test('renameProject rejects empty, overlong, missing, and trashed projects', async t => {
  const home = await mkdtemp(join(tmpdir(), 'lake-project-rename-err-')), data = join(home, 'data');
  const store = await LakeStore.open(home, data);
  t.after(async () => {store.close(); await rm(home, {recursive: true, force: true});});

  const created = store.createProject('测试项目');
  assert.throws(() => store.renameProject(created.id, '   '), err => err instanceof HttpError && err.status === 400);
  assert.throws(() => store.renameProject(created.id, 'a'.repeat(121)), err => err instanceof HttpError && err.status === 400);
  assert.throws(() => store.renameProject('missing-id', '新名称'), err => err instanceof HttpError && err.status === 404);

  store.put('navigationTrash', `project:${created.id}`, {
    kind: 'project',
    id: created.id,
    projectId: created.id,
    name: created.name,
    deletedAt: new Date().toISOString(),
  });
  assert.throws(() => store.renameProject(created.id, '已删除项目'), err => err instanceof HttpError && err.status === 404);
});
