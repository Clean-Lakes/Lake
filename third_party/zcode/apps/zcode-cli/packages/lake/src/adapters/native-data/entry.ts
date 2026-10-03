import { createInterface } from 'node:readline';
import { NativeLakeDataService } from './service.js';
import { serveNativeLakeMcp } from './mcp.js';

/** Separate process owns SQLite only; it never creates an Agent or legacy workflow runner. */
async function main(): Promise<void> {
  const data = await NativeLakeDataService.open();
  const args = process.argv.slice(2);
  if (args[0] === '--mcp') {
    if (args[1] !== '--workspace' || !args[2] || args.length !== 3) throw new Error('LAKE MCP 需要工作空间路径');
    await serveNativeLakeMcp(data, args[2]); return;
  }
  if (args[0] !== '--rpc') {
    try { process.stdout.write(JSON.stringify(await data.request(JSON.parse(args.join(' ') || '{"action":"overview"}')), null, 2) + '\n'); }
    finally { data.close(); }
    return;
  }
  const lines = createInterface({ input: process.stdin });
  try {
    for await (const line of lines) {
      let id: unknown = null;
      try {
        if (Buffer.byteLength(line) > 65536) throw new Error('请求过大');
        const message = JSON.parse(line) as { id: unknown; params: unknown };
        id = message.id;
        if (typeof id !== 'number' || !Number.isSafeInteger(id)) throw new Error('无效的请求编号');
        const result = await data.request(message.params);
        process.stdout.write(JSON.stringify({ id, result }) + '\n');
      } catch {
        process.stdout.write(JSON.stringify({ id, error: 'LAKE 数据请求失败，请检查湖、目录和参数。' }) + '\n');
      }
    }
  } finally { data.close(); }
}
void main().catch(() => { process.stderr.write('LAKE 数据服务启动失败\n'); process.exitCode = 1; });
