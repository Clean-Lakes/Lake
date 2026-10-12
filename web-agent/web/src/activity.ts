import type { AICard, AIView } from "../../shared/contracts";
import { compareTime } from "./timeline";

export const toolLabels: Record<string, string> = {
  inspect_host: "检查主机状态", shell: "执行命令", terminal_execute_command: "执行终端命令",
  list_assets: "查找资源", read: "读取文件", read_file: "读取文件",
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
export function turnProgress(view: AIView, cards: AICard[], latestUserAt: string, now: number, thinkingVisible = false): { activity?: Activity; elapsed?: string } {
  const live = ["running", "waiting_approval"].includes(view.status);
  const start = view.turnStartedAt && (!latestUserAt || compareTime(view.turnStartedAt, latestUserAt) >= 0) ? view.turnStartedAt : live ? latestUserAt : "";
  const turnCards = start ? cards.filter(card => compareTime(card.at, start) >= 0) : [];
  const current = turnCards.filter(card => ["operation", "shell"].includes(card.type) && ["running", "pending"].includes(card.status)).at(-1);
  let activity: Activity | undefined;
  if (live) {
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
  // The timeline header already owns generic thinking, including when collapsed.
  if (thinkingVisible && activity?.text === "正在思考") activity = undefined;
  return { activity, elapsed: Number.isFinite(seconds) && seconds >= 0 && view.status !== "idle" && !instantConversation ? formatElapsed(seconds) : undefined };
}
export function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
  return `${hours ? `${hours}小时 ` : ""}${minutes ? `${minutes}分钟 ` : ""}${rest}秒`;
}
