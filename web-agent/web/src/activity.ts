import type { AICard, AIView } from "../../shared/contracts";
import { compareTime } from "./timeline";
import type {GlyphName} from './Icons';

/** Use the actual tool identity, never shell text or its untrusted result. */
export function progressGlyph(card?:AICard):GlyphName {
 if(!card||card.type==='thinking')return 'lakeProcess';
 const name=card.title??'';
 if(card.type==='shell'||/shell|terminal/.test(name))return 'lakeTerminal';
 if(/^(schedule_)/.test(name))return 'lakeSchedule';
 if(/mcp/.test(name))return 'lakeNetwork';
 if(name==='ask_user_question')return 'lakeQuestion';
 if(/workflow|^todo_|^task_|investigation/.test(name))return 'lakeWorkflow';
 if(/sql|^list_db_|^db_|redis|^observe_data$/.test(name))return 'lakeDatabase';
 if(/docker|cluster/.test(name))return 'lakeContainer';
 if(/search|grep|glob|fetch/.test(name))return 'lakeSearch';
 if(/^(ls|list_files|list_resource_groups)$/.test(name))return 'lakeFolder';
 if(/^(inspect_host|observe_host|list_assets)$/.test(name))return 'lakeHost';
 if(/read|write|edit|append|delete|file|attachment|transfer|skill|evidence|journal|logs/.test(name))return 'lakeFile';
 return 'lakeProcess';
}

export const toolLabels: Record<string, string> = {
 inspect_attachment:"检查附件",stage_attachment:"传输附件",
 list_mcp_servers:"查看 MCP 服务",list_mcp_tools:"查看 MCP 工具",call_mcp_tool:"调用 MCP 工具",
 todo_read:"查看任务进度",todo_write:"更新任务进度",ask_user_question:"询问你的选择",read_session_context:"查阅历史会话",load_skill:"加载技能",list_workflows:"查看工作流",get_workflow_run:"查看工作流结果",run_workflow:"运行工作流",save_workflow:"保存工作流",schedule_create:"创建定时任务",schedule_list:"查看定时任务",schedule_update:"更新定时任务",schedule_delete:"删除定时任务",task_output:"查看任务结果",task_stop:"停止任务",read_tool_result:"读取完整工具结果",
  observe_host: "检查主机指标", observe_cluster: "检查 Kubernetes 集群", observe_cluster_logs: "读取 Pod 日志", observe_journal: "读取服务日志", observe_logs: "查看应用日志", observe_data: "检查数据服务", read_evidence: "复核原始证据", delegate_investigation: "分派调查任务", read_investigation: "查看调查结果",
  inspect_host: "检查主机状态", shell: "执行命令", terminal_execute_command: "执行终端命令",
  list_assets: "查找资源", list_resource_groups: "查看资源目录", read: "读取文件", read_file: "读取文件",
  write: "写入文件", write_file: "写入文件", append: "追加文件", edit: "编辑文件",
  edit_file: "编辑文件", multi_edit: "编辑文件", delete: "删除文件",
  ls: "列出文件", glob: "查找文件", grep: "搜索文件", list_files: "列出文件",
  search_files: "搜索文件", web_search: "搜索网页", search_web: "搜索网页",
  web_fetch: "读取网页", fetch_url: "读取网页", query_sql: "查询数据库",
  execute_sql: "执行 SQL", list_db_objects: "查看数据库对象", db_table_ddl: "读取表结构",
  list_docker_containers: "查看容器", docker_container_logs: "读取容器日志",
  docker_container_action: "操作容器", redis_command: "执行 Redis 命令",
  read_terminal_screen: "读取终端", terminal_read: "读取终端", ssh_terminal_read: "读取终端",
  wait_shell: "等待命令结束", shell_output: "读取命令输出", kill_shell: "停止命令",
  open_ssh_terminal: "创建终端", close_ssh_terminal: "关闭终端", scp_transfer: "传输文件",
};
export type Activity = { text: string; detail?: string; icon: "file" | "search" | "terminal" | "host" | "thinking" | "approval" };
const clean = (value: unknown) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120) : "";
export function toolActivity(card: AICard, waiting = false): Activity {
  const name = card.title || "";
  const data = card.data && typeof card.data === "object" ? card.data as Record<string, unknown> : {};
  const args = data.arguments && typeof data.arguments === "object" ? data.arguments as Record<string, unknown> : {};
  const file = /^(read|read_file|write|write_file|append|edit|edit_file|multi_edit|delete)$/.test(name);
  const path = clean(args.path ?? args.file_path);
  const leaf = path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "文件";
  const fileVerb = /^(read|read_file)$/.test(name) ? "读取" : name === "delete" ? "删除" : /^(write|write_file)$/.test(name) ? "写入" : name === "append" ? "追加" : "编辑";
  const action = file ? `${fileVerb} ${leaf}` : toolLabels[name] || "执行操作";
  return { text: `${waiting ? "等待授权" : "正在"}${action}`, detail: clean(data.target) || undefined,
    icon: waiting ? "approval" : file ? "file" : /search|grep|glob|fetch/.test(name) ? "search" : /shell|terminal/.test(name) ? "terminal" : "host" };
}
// Limit activity to the newest turn, even when old pending/running cards are retained.
export function turnProgress(view: AIView, cards: AICard[], latestUserAt: string, now: number): { activity?: Activity; elapsed?: string } {
  const live = ["running", "waiting_approval"].includes(view.status);
  const start = view.turnStartedAt && (!latestUserAt || compareTime(view.turnStartedAt, latestUserAt) >= 0) ? view.turnStartedAt : live ? latestUserAt : "";
  const turnCards = start ? cards.filter(card => compareTime(card.at, start) >= 0) : [];
  const current = turnCards.filter(card => ["operation", "shell"].includes(card.type) && ["running", "pending"].includes(card.status)).at(-1);
  let activity: Activity | undefined;
  if (live) {
    if(view.question) return {activity:{text:"等待你的选择",icon:"approval"}};
    if (current) {
      activity = toolActivity(current, current.status === "pending" || view.status === "waiting_approval");
      if (current.status === "pending" && view.pending?.kind === "terminal_open") activity.text = "等待授权创建终端";
    }
    else if (view.status === "waiting_approval") activity = {text: "等待操作授权", icon: "approval"};
    else activity = { text: turnCards.at(-1)?.type === "message" && turnCards.at(-1)?.content ? "正在生成回复" : "正在思考", icon: "thinking" };
  }
  const end = live ? now : Date.parse(view.turnFinishedAt || "");
  const seconds = Math.floor((end - Date.parse(start)) / 1000);
  const instantConversation = !live && seconds === 0 && !turnCards.some(card => ["operation", "shell"].includes(card.type));
  return { activity, elapsed: Number.isFinite(seconds) && seconds >= 0 && view.status !== "idle" && !instantConversation ? formatElapsed(seconds) : undefined };
}
export function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return `${hours ? `${hours}小时 ` : ""}${minutes ? `${minutes}分钟 ` : ""}${rest}秒`;
}

/** Describe recognizable executed commands, never echo their contents into the summary. */
function shellDescription(command:unknown):string|undefined {
 if(typeof command!=="string")return;
 // Only executable positions count: `echo uname` is not a system inspection.
 const prefix="(?:^|[\\n;]|&&|\\|\\|)\\s*(?:sudo\\s+)?";
 const executables=command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g," ").replace(/#[^\n]*/g," ");
 const executes=(pattern:string)=>new RegExp(prefix+pattern,"m").test(executables);
 const labels:string[]=[];
 if(executes("(?:uname|hostname|lscpu|lsblk|dmidecode|uptime|free|vmstat|df)\\b") || executes("cat\\s+/(?:etc/(?:os-release|redhat-release)|proc/(?:cpuinfo|meminfo))\\b"))labels.push("检查系统与资源");
 if(executes("systemctl\\s+(?:status|show|is-active|list-units|list-unit-files)\\b"))labels.push("检查服务状态");
 if(executes("(?:ps|ss|netstat|pgrep)\\b"))labels.push("检查进程与连接");
 if(executes("(?:mysql|psql|mongo|mongosh|redis-cli)\\b"))labels.push("执行数据库命令");
 return labels.length ? labels.slice(0,2).join("、")+(labels.length>2 ? "等" : "") : undefined;
}
/** Descriptive text for collapsed process rows, without copying command contents. */
export function toolDescription(card:AICard): string {
 const activity=toolActivity(card);
 const data=card.data&&typeof card.data==="object" ? card.data as Record<string,unknown> : {};
 const args=data.arguments&&typeof data.arguments==="object" ? data.arguments as Record<string,unknown> : {};
 const action=["shell","terminal_execute_command"].includes(card.title??"") ? shellDescription(args.command) || activity.text.replace(/^正在/,"") : activity.text.replace(/^正在/,"");
 const pattern=card.title==="list_assets" ? clean(args.pattern) : "";
 return [action,pattern,activity.detail].filter(Boolean).join(" · ");
}
export function processDescription(cards:AICard[]): string {
 const tools=cards.filter(card=>card.type!=="thinking");
 if(!tools.length)return "分析问题";
 const labels=[...new Set(tools.map(toolDescription))];
 return labels.slice(0,2).join("、")+(labels.length>2 ? ` 等 ${tools.length} 项操作` : tools.length>labels.length ? `（${tools.length} 次）` : "");
}
