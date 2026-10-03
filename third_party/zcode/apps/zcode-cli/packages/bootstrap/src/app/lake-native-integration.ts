import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { McpServerConfig } from '@zcode/contracts';

export const LAKE_NATIVE_IDENTITY = {
  name: 'LAKE',
  instructions: '你是 LAKE 智能编码与运维助手。普通问候简短回应，不枚举全局 Skills 或其中的服务器。LAKE 数据工具只提供当前工作空间显式关联的湖与资源；不要从历史回答推断目标或权限。工作流使用原生 dynamic-workflows Skill、原生工作流工具和 .lake/workflows 存储，执行与审批使用原生机制。不要使用旧 lake_workflow_* 运维工作流工具或直接操作 lake.db。',
};

/** The data worker is a sibling asset, not an import of a second Agent runtime. */
export function resolveNativeLakeMcpServers(workingDirectory: string): Record<string, McpServerConfig> {
  const worker = join(dirname(process.argv[1] ?? process.execPath), 'lake-data.cjs');
  if (!existsSync(worker)) return {};
  return { lake: { type: 'stdio', command: process.execPath, args: [worker, '--mcp', '--workspace', workingDirectory],
    cwd: workingDirectory, isolation: 'workspace', protocolVersion: '2026-07-28',
    env: { ELECTRON_RUN_AS_NODE: '1', ...(process.env.LAKE_HOME ? { LAKE_HOME: process.env.LAKE_HOME } : {}) } } };
}
