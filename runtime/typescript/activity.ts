/** Ephemeral SDK execution activity. Scheduled calls and historical cards are not execution. */
export class LiveToolActivity {
  private sessions = new Map<string, Map<string, { toolName: string; startedAt: string }>>();
  start(sessionId: string, callId: string, toolName: string, startedAt: string) {
    const calls = this.sessions.get(sessionId) ?? new Map();
    calls.set(callId, { toolName, startedAt }); this.sessions.set(sessionId, calls);
  }
  finish(sessionId: string, callId: string) {
    const calls = this.sessions.get(sessionId); calls?.delete(callId);
    if (!calls?.size) this.sessions.delete(sessionId);
  }
  clear(sessionId: string) { this.sessions.delete(sessionId); }
  latest(sessionId: string) { return [...(this.sessions.get(sessionId)?.values() ?? [])].at(-1); }
}

export function toolActivityLabel(name: string) {
  return ({ list_db_objects:"正在读取数据库目录",db_table_ddl:"正在读取表结构",read_db_table:"正在读取数据库数据", inspect_host: "正在读取服务器指标", list_assets: "正在查找资源", list_project_files: "正在查看项目文件",
    list_resource_config:'正在读取资源配置',manage_resource:'正在保存资源配置',list_skill_config:'正在读取技能配置',manage_skill:'正在保存技能配置',list_mcp_config:'正在读取 MCP 配置',manage_mcp:'正在保存 MCP 配置',test_mcp_config:'正在测试 MCP 连接',
    Read: "正在读取文件", Write: "正在写入文件", Edit: "正在修改文件", list_mcp_servers: "正在查找可用服务",
    list_mcp_tools: "正在查看服务能力", call_mcp_tool: "正在处理服务操作", load_skill: "正在查阅操作指引",
    read_referenced_task_evidence: "正在查看历史检查结果", read_tool_output: "正在读取工具回执" } as Record<string, string>)[name] ?? "正在处理任务";
}
