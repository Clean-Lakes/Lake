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
  return ({ inspect_host: "正在读取服务器指标", list_assets: "正在查找资源", list_project_files: "正在查看项目文件",
    Read: "正在读取文件", Write: "正在写入文件", Edit: "正在修改文件", list_mcp_servers: "正在查找可用服务",
    list_mcp_tools: "正在查看服务能力", call_mcp_tool: "正在处理服务操作", load_skill: "正在查阅操作指引",
    read_referenced_task_evidence: "正在查看历史检查结果" } as Record<string, string>)[name] ?? "正在处理任务";
}
