import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { NativeLakeDataService } from '../dist/adapters/native-data/service.js';

test('native MCP negotiates, scopes data and rejects scope changes and forged lake arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lake-native-mcp-'));
  const data = await NativeLakeDataService.open(root);
  const client = new Client({ name: 'fixture', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } });
  try {
    const a = await data.request({ action: 'lake.add', name: 'A' });
    const b = await data.request({ action: 'lake.add', name: 'B' });
    const workspace = await data.request({ action: 'workspace.ensure', lakeID: a.id });
    for (const [lakeID, name] of [[a.id, 'host-a'], [b.id, 'host-b']]) await data.request({ action: 'resource.add', lakeID, name, host: 'example.invalid', port: 22, username: 'fixture' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dirname, '../dist/lake-data.cjs'), '--mcp', '--workspace', workspace.workspacePath], env: { LAKE_HOME: root }, stderr: 'ignore' });
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 3);
    const result = await client.callTool({ name: 'lake_resources', arguments: {} });
    assert.deepEqual(JSON.parse(result.content[0].text).map(item => item.name), ['host-a']);
    assert.equal((await client.callTool({ name: 'lake_resources', arguments: { lakeID: b.id } })).isError, true);
    await data.request({ action: 'workspace.bind', lakeID: b.id, workspacePath: workspace.workspacePath });
    assert.equal((await client.callTool({ name: 'lake_resources', arguments: {} })).isError, true);
  } finally { await client.close(); data.close(); await rm(root, { recursive: true, force: true }); }
});
