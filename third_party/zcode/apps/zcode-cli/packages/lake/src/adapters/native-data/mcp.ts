import { Server, type Tool } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { NativeLakeDataService } from './service.js';

const empty = z.object({}).strict();
const tools: Tool[] = [
  { name: 'lake_context', description: 'Read the LAKE lake explicitly associated with this native workspace. No implicit current-lake access.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'lake_resources', description: 'List resources belonging to this workspace’s associated lake. Credentials are never returned. Use native tools and native permissions for operations.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'lake_journal', description: 'Read the associated lake’s operation journal summaries.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
];

export async function createNativeLakeMcp(data: NativeLakeDataService, workspacePath: string): Promise<Server> {
  const captured = data.associations.forWorkspace(workspacePath);
  const server = new Server({ name: 'LAKE data', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: 'LAKE supplies lake data only. Workflows, tools, approvals and execution belong to the native runtime. Never use legacy lake_workflow_* tools.' });
  server.setRequestHandler('tools/list', async () => ({ tools }));
  server.setRequestHandler('tools/call', async request => {
    try {
      empty.parse(request.params.arguments ?? {});
      const binding = data.associations.forWorkspace(workspacePath);
      if (!captured || !binding || captured.lakeID !== binding.lakeID) throw new Error('此工作空间尚未关联湖，或关联已变化。请在客户端关联后创建新会话。');
      let result: unknown;
      switch (request.params.name) {
        case 'lake_context': result = binding; break;
        case 'lake_resources': {
          const overview = await data.request({ action: 'overview' });
          if (!('resources' in overview)) throw new Error('无效的湖数据');
          result = overview.resources.filter(resource => resource.lake === binding.lakeName); break;
        }
        case 'lake_journal': result = await data.request({ action: 'journal.list', lakeID: binding.lakeID }); break;
        default: throw new Error('未知的 LAKE 数据工具');
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch {
      return { isError: true, content: [{ type: 'text' as const, text: 'LAKE 数据请求被拒绝：请检查工作空间的湖关联和参数；关联变化后创建新会话。' }] };
    }
  });
  return server;
}

export async function serveNativeLakeMcp(data: NativeLakeDataService, workspacePath: string): Promise<void> {
  const server = await createNativeLakeMcp(data, workspacePath);
  const transport = serveStdio(() => server, { legacy: 'reject' });
  const close = () => { void transport.close().finally(() => { data.close(); process.exit(0); }); };
  process.once('SIGTERM', close); process.once('SIGINT', close); process.stdin.once('end', close);
}
