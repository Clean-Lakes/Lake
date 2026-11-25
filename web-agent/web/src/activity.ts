import {toolLabels} from '../../shared/tool-labels';
export {toolLabels};
import type { AICard, AIView } from "../../shared/contracts";
import { compareTime } from "./timeline";
import type {GlyphName} from './Icons';
import {quietCoordination} from './coordinationActivity';

/** Use the actual tool identity, never shell text or its untrusted result. */
export function progressGlyph(card?:AICard):GlyphName {
 if(!card||card.type==='thinking')return 'lakeProcess';
 const name=card.title??'';
 if(card.type==='shell'||/shell|terminal/.test(name))return 'lakeTerminal';
 if(/^(schedule_)/.test(name))return 'lakeSchedule';
 if(/mcp/.test(name))return 'lakeNetwork';
 if(name==='ask_user_question')return 'lakeQuestion';
 if(name==='route_work'||/workflow|^todo_|^task_|investigation|^Todo(Read|Write)$/.test(name))return 'lakeWorkflow';
 if(/sql|^list_db_|^db_|redis|^observe_data$/.test(name))return 'lakeDatabase';
 if(/docker|cluster|kubernetes/.test(name))return 'lakeContainer';
 if(/search|grep|glob|fetch/.test(name)||name==='list_assets')return 'lakeSearch';
 if(/^(ls|list_files|list_resource_groups)$/.test(name))return 'lakeFolder';
 if(/^(inspect_host|observe_host)$/.test(name))return 'lakeHost';
 if(/read|write|edit|append|delete|file|attachment|transfer|skill|evidence|journal|logs/.test(name))return 'lakeFile';
 return 'lakeProcess';
}

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
  const current = turnCards.filter(card => ["operation", "shell"].includes(card.type) && ["running", "pending"].includes(card.status) && !quietCoordination(card)).at(-1);
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
