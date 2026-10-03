import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeLakeDataService } from '../dist/adapters/native-data/service.js';
import { FileVault } from '../dist/adapters/vault.js';
import { saveModelConfig } from '../dist/adapters/config/files.js';

test('native lake associations persist, reject foreign workflows and never return credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lake-native-'));
  let data = await NativeLakeDataService.open(root);
  try {
    const a = await data.request({ action: 'lake.add', name: 'A' });
    const b = await data.request({ action: 'lake.add', name: 'B' });
    const workspace = await data.request({ action: 'workspace.ensure', lakeID: a.id });
    await symlink(workspace.workspacePath, join(root, 'alias'));
    assert.equal(data.associations.forWorkspace(join(root, 'alias')).lakeID, a.id);
    await data.request({ action: 'workflow.bind', lakeID: a.id, workspacePath: workspace.workspacePath, name: 'native-check', scope: 'project' });
    await assert.rejects(data.request({ action: 'workflow.bind', lakeID: b.id, workspacePath: workspace.workspacePath, name: 'native-check', scope: 'project' }));
    await assert.rejects(data.request({ action: 'workspace.bind', lakeID: b.id, workspacePath: 'relative' }));
    await assert.rejects(data.request({ action: 'resource.add', lakeID: a.id, name: 'host', host: 'example.invalid', port: 22, username: 'fixture', privateKey: 'must-be-rejected' }));
    const host = await data.data.request('res.add', { lake: a.id, name: 'host', credential_ref: 'file:ssh/fixture', spec: { ssh: { host: 'example.invalid', username: 'fixture', injected_secret: 'must-not-leak' } } });
    assert.equal(host.execute_authz, false);
    const view = await data.request({ action: 'overview' });
    assert.equal(view.workflowLinks.length, 1);
    assert.equal(JSON.stringify(view).includes('must-not-leak'), false);
    assert.equal(JSON.stringify(view).includes('file:ssh'), false);
    data.close(); data = await NativeLakeDataService.open(root);
    assert.equal((await data.request({ action: 'overview' })).bindings[0].lakeID, a.id);
    await data.request({ action: 'workspace.bind', lakeID: b.id, workspacePath: workspace.workspacePath });
    assert.equal((await data.request({ action: 'overview' })).workflowLinks.length, 0);
    assert.equal((await data.data.request('workflow.v2.list', {})).length, 0, 'native links must not create legacy definitions');
  } finally { data.close(); await rm(root, { recursive: true, force: true }); }
});

test('LAKE model import uses the native private repository once and leaves source/vault intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lake-model-import-'));
  try {
    const vault = new FileVault(root);
    await vault.put('model', 'fixture', Buffer.from('synthetic-fixture-token'));
    await saveModelConfig(root, { model: 'fixture-model', model_provider: 'fixture', context_window: 32000, max_output_tokens: 4096,
      model_providers: { fixture: { base_url: 'https://example.invalid/v1', wire_api: 'openai_chat' } }, model_catalog: { 'fixture-model': 'fixture' } });
    const data = await NativeLakeDataService.open(root); data.close();
    const nativeFile = join(root, 'v2/provider_config.json'), before = await readFile(nativeFile, 'utf8');
    const config = JSON.parse(before);
    assert.deepEqual(config.config.defaultModelSelection, { providerId: 'fixture', modelId: 'fixture-model' });
    assert.equal(config.config.providerConfigRules.providerRules[0].config.api.type, 'openai-chat-completions');
    assert.equal((await stat(nativeFile)).mode & 0o777, 0o600);
    assert.equal(await vault.has('model', 'fixture'), true);
    const second = await NativeLakeDataService.open(root); second.close();
    assert.equal(await readFile(nativeFile, 'utf8'), before);
    assert.equal((await stat(join(root, 'config.toml'))).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});
