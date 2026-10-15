import {AppSelect} from "./AppSelect";
import { AgentQuestion } from "./AgentQuestion";
import { ReplyDuration } from "./ReplyDuration";
import { timingForTurn } from "./replyDurationState";
import {displayAiError} from "./aiErrors";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkAssistantProse } from "./assistantProse";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { AIImage, AICard, AIView, AIPreset, SessionSnapshot, TerminalSession, WorkspaceTag } from "../../shared/contracts";
import { conversationTagSignature, remarkConversationTags } from "./conversationTags";
import { orderedTranscript, transcriptGroups, transcriptTurns } from "./timeline";
import { FileChanges } from "./FileChanges";
import { isFileChangeCard } from "./file-changes-model";
import { sameCard } from "./cardEquality";
import { ThinkingTimeline } from "./ThinkingTimeline";
import { PermissionSettings, permissionDefaults } from "./PermissionSettings";
import { api, readableError } from "./api";
import { ImportResourceRows } from "./ResourceImport";
import { AgentTaskList } from "./AgentTaskList";
import { AgentIcon } from "./AgentIcon";
import { ConversationDirectory, conversationDirectoryItems, conversationTurnId } from "./ConversationDirectory";

function Chart({ card }: { card: AICard }) {
  const data = card.data as { type?: string; title?: string; labels: string[]; values?: number[]; series?: Array<{ name?: string; values: number[] }> };
  const series = data.series?.length ? data.series : [{ name: card.title || "数值", values: data.values ?? [] }];
  const values = series.flatMap(series => series.values);
  const max = Math.max(1, ...values.map(Math.abs));
  const colors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];
  const count = data.labels.length;
  const pie = data.type === "pie" || data.type === "doughnut";
  const total = series[0]!.values.reduce((sum, value) => sum + Math.max(0, value), 0);
  let angle = -Math.PI / 2;
  return <figure className="ai-chart"><figcaption>{card.title || "数据图表"}</figcaption><svg viewBox="0 0 640 290" role="img" aria-label={card.title || "数据图表"}>
    {pie ? series[0]!.values.map((value, i) => { const start = angle; angle += Math.max(0, value) / (total || 1) * Math.PI * 2; const end = angle; const x = (a: number) => 320 + 112 * Math.cos(a); const y = (a: number) => 140 + 112 * Math.sin(a); return value >= total ? <circle key={i} cx={320} cy={140} r={112} fill={colors[i % colors.length]}><title>{data.labels[i]}：{value}</title></circle> : <path key={i} d={`M320,140 L${x(start)},${y(start)} A112,112 0 ${end - start > Math.PI ? 1 : 0},1 ${x(end)},${y(end)} Z`} fill={colors[i % colors.length]}><title>{data.labels[i]}：{value}</title></path>; }) : <>
      <line x1={35} y1={240} x2={620} y2={240} stroke="var(--border)"/>
      {series.map((item, j) => data.type === "line" ? <polyline key={j} fill="none" stroke={colors[j % colors.length]} strokeWidth={3} points={item.values.map((value, i) => `${40 + i * 570 / Math.max(1, count - 1)},${230 - value / max * 200}`).join(" ")}/> : item.values.map((value, i) => <rect key={`${j}-${i}`} x={38 + i * 578 / count + j * 540 / count / series.length} y={value >= 0 ? 230 - value / max * 190 : 230} width={Math.max(1, 520 / count / series.length - 3)} height={Math.abs(value) / max * 190} fill={colors[j % colors.length]}><title>{data.labels[i]} · {item.name}：{value}</title></rect>))}
      {data.labels.slice(0, 24).map((label, i) => <text key={i} x={40 + i * 570 / Math.max(1, count - 1)} y={268} fontSize={11} textAnchor="middle">{label.slice(0, 10)}</text>)}
    </>}
    {data.type === "doughnut" && <circle cx={320} cy={140} r={65} fill="var(--surface)"/>}
  </svg><details><summary>查看数据</summary><table><thead><tr><th>项目</th>{series.map((item, i) => <th key={i}>{item.name || "数值"}</th>)}</tr></thead><tbody>{data.labels.map((label, i) => <tr key={i}><td>{label}</td>{series.map((item, j) => <td key={j}>{item.values[i]}</td>)}</tr>)}</tbody></table></details></figure>;
}
const noTags: WorkspaceTag[] = [];
const Card = memo(function Card({ card, tags = noTags }: { card: AICard; tags?: WorkspaceTag[] }) {
  const signature = conversationTagSignature(tags);
  const decorateTags = useMemo(() => remarkConversationTags(tags), [signature]);
  const assistantText = ["text", "message"].includes(card.type);
  const content = card.type === "error" ? card.status === "cancelled" ? "已停止本轮" : displayAiError(card.content || "") : card.content;
  if (card.type === "image") { const image = card.data as AIImage; return <figure className="ai-image"><img src={`data:${image.mimeType};base64,${image.base64}`} alt={image.name || "模型返回图片"}/><a href={`data:${image.mimeType};base64,${image.base64}`} download={image.name || `lake-image.${image.mimeType.split("/")[1]}`}>保存图片</a></figure>; }
  if (card.type === "thinking") return <details className="ai-thinking"><summary>思考过程 {card.status === "running" ? "· 正在生成" : ""}</summary><div>{card.content}</div></details>;
  if (card.type === "chart") return <Chart card={card}/>;
  if (card.type === "diff") { const data = card.data as { before: string; after: string }; return <details className="ai-diff"><summary>文件变更 · {card.title}</summary><div className="ai-diff-columns"><pre>{data.before || "（新文件）"}</pre><pre>{data.after || "（空文件或删除）"}</pre></div></details>; }
  if (card.type === "operation") return <details className="ai-operation"><summary><span>{card.title}</span><small>{card.status === "pending" ? "等待确认" : card.status === "running" ? "执行中" : card.status === "failed" ? "未完成" : "已结束"}</small></summary><pre>{JSON.stringify(card.data, null, 2)}</pre>{card.content && <pre>{card.content}</pre>}</details>;
  return <div className={`ai-card ai-${card.type}`}><div className={`ai-markdown${assistantText ? " assistant-prose" : ""}`}><Markdown remarkPlugins={assistantText ? [remarkGfm, remarkAssistantProse, decorateTags] : [remarkGfm]} skipHtml components={{ a: props => <a {...props} target="_blank" rel="noopener noreferrer"/>, table: props => <div className="markdown-table-scroll"><table {...props}/></div> }}>{content || ""}</Markdown></div>{card.status === "running" && <span className="ai-stream-dot"/>}</div>;
}, (previous, next) => sameCard(previous.card, next.card) && conversationTagSignature(previous.tags) === conversationTagSignature(next.tags));
export function AITranscript({ snapshot, renderAction, onInspect, onStopTurn, stopping = false, disabled = false, mode = "conversation" }: { mode?: "conversation" | "activity" | "evidence"; snapshot: SessionSnapshot; renderAction?: (action: SessionSnapshot["actions"][number]) => ReactNode; onInspect?: () => void; onStopTurn?: () => void; stopping?: boolean; disabled?: boolean }) {
  const [older, setOlder] = useState<AICard[]>([]); const [offset, setOffset] = useState<number | null>(null); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const transcript = useRef<HTMLDivElement>(null);
  useEffect(() => { setOlder([]); setOffset(null); setError(""); }, [snapshot.session.id]);
  const cards = [...older.filter(c => !snapshot.ai?.cards.some(current => current.id === c.id)), ...(snapshot.ai?.cards ?? [])];
  const before = offset ?? snapshot.ai?.cardsOffset ?? 0;
  const loadOlder = async () => { setLoading(true); try { const page = await api.aiCards(snapshot.session.id, before); setOlder(current => [...page.cards, ...current]); setOffset(page.cardsOffset); } catch (error) { setError(readableError(error)); } finally { setLoading(false); } };
  const entries = orderedTranscript(snapshot, cards, before);
  const visibleEntries = entries.filter(entry => !isFileChangeCard(entry.card));
  const groups = transcriptGroups(visibleEntries);
  const activityEntry = (entry: (typeof entries)[number]) => !!(entry.agentRun || entry.action || entry.card && ["thinking", "operation", "shell", "diff", "error"].includes(entry.card.type));
  const turns = transcriptTurns(entries).filter(turn => mode !== "activity" || turn.some(activityEntry));
  const directoryItems = conversationDirectoryItems(snapshot.messages, new Set(turns.flatMap(turn => turn.filter(entry => entry.message?.role === "user").map(entry => entry.id))));
  function jumpTo(entryId?: string) {
    onInspect?.();
    const container = transcript.current?.closest<HTMLElement>(".conversation");
    const target = entryId ? document.getElementById(conversationTurnId(snapshot.session.id, entryId)) : null;
    if (!container || entryId && !target) return;
    const top = target ? container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - 16 : container.scrollHeight;
    container.scrollTo({top: Math.max(0, top), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"});
  }
  const tail = groups.at(-1);
  const thinkingVisible = !!tail?.some(entry => entry.agentRun || entry.card && ["thinking", "operation", "shell"].includes(entry.card.type)) && ["running", "waiting_approval"].includes(snapshot.ai?.status || "");
  const latestUser = snapshot.messages.filter(message => message.role === "user").at(-1);
  const latestUserAt = latestUser?.createdAt || "";
  if (mode === "evidence") {
    const evidence = [...new Map([...(snapshot.evidence || []), ...(snapshot.ai?.agentRuns || []).flatMap(run => run.evidence || [])].filter(item => item.sessionId === snapshot.session.id).map(item => [item.id,item])).values()];
    const reports = cards.filter(card => ["chart", "image"].includes(card.type));
    return <div className="ai-transcript evidence-view">{before > 0 && <button type="button" disabled={loading} onClick={() => void loadOlder()}>{loading ? "正在加载…" : "加载更早记录"}</button>}{error && <p role="alert">{error}</p>}{!evidence.length && !reports.length && <div className="record-empty"><h2>暂无已记录证据</h2><p>调查中的图表、图片和取证结果会保留在这里。</p></div>}{reports.map(card => <Card key={card.id} card={card}/>)}{evidence.map(item => <section key={item.id} className="evidence-record"><header><strong>{item.title}</strong><small>{snapshot.resources.find(resource => resource.id===item.resourceId)?.name || "调查证据"}</small></header>{"command" in item && item.command && <pre>{item.command}</pre>}<pre>{item.excerpt}</pre><small>{item.exitCode !== null ? `退出码 ${item.exitCode} · ` : ""}{new Date(item.collectedAt).toLocaleString("zh-CN")}</small></section>)}</div>;
  }
  return <div className="ai-transcript" ref={transcript}>
    <ConversationDirectory key={snapshot.session.id} sessionId={snapshot.session.id} items={directoryItems} onJump={jumpTo} onLatest={() => jumpTo()} onOpen={onInspect} onLoadOlder={before > 0 ? () => void loadOlder() : undefined} loading={loading}/>
    {mode === "activity" && !turns.length && <div className="record-empty"><h2>暂无执行记录</h2><p>工具调用、子 Agent 任务和文件变更会按轮次保留在这里。</p></div>}
    {before > 0 && <button type="button" disabled={loading} onClick={() => void loadOlder()}>{loading ? "正在加载…" : "加载更早记录"}</button>}
    {error && <p role="alert">{error}</p>}
    {turns.map((turn, index) => <div className="ai-turn" id={conversationTurnId(snapshot.session.id, turn[0]!.id)} key={turn[0]!.id}>
      {transcriptGroups(turn.filter(entry => !isFileChangeCard(entry.card) && (mode !== "activity" || activityEntry(entry)))).map(group => {
        const entry = group[0]!;
        const runs = group.flatMap(item => item.agentRun ? [item.agentRun] : []);
        if (runs.length) {
          const tools = group.flatMap(item => item.card ? [item.card] : []);
          const live = ["running", "waiting_approval"].includes(snapshot.ai?.status || "") && runs.some(run => run.rootTurnId && snapshot.ai?.rootTurnId ? run.rootTurnId === snapshot.ai.rootTurnId : !latestUserAt || Date.parse(run.createdAt) >= Date.parse(latestUserAt));
          return <AgentTaskList compact key={entry.id} runs={runs} resources={snapshot.resources || []} evidence={[...(snapshot.evidence || []), ...(snapshot.ai?.agentRuns || []).flatMap(run => (run.evidence || []).map(item => ({...item, specialistId:null, command:null})))]} live={live} disabled={disabled} stopping={stopping} onInspect={onInspect} onStopTurn={onStopTurn} onCancelRun={run => api.aiOperation(snapshot.session.id,"cancelAgent",{runId:run.id})} renderApproval={run => snapshot.ai && <AIPending session={snapshot.session.id} runId={run.id} agentName={run.name} view={{...snapshot.ai,pending:run.pending}} refresh={() => api.aiView(snapshot.session.id)}/>}>{tools.length ? <ThinkingTimeline cards={tools} live={false} onInspect={onInspect}/> : null}</AgentTaskList>;
        }
        if (entry.card && ["thinking", "operation", "shell"].includes(entry.card.type)) return <ThinkingTimeline key={entry.id} cards={group.map(item => item.card!)} live={thinkingVisible && group.at(-1)?.id === visibleEntries.at(-1)?.id} onInspect={onInspect}/>;
        if (entry.message) return <div key={entry.id} className={`ai-chat-message ai-role-${entry.message.role}`}>
          {entry.message.role !== "user" && <small>系统</small>}{entry.message.text && <div>{entry.message.role === "system" ? displayAiError(entry.message.text) : entry.message.text}</div>}
          {entry.message.images?.map(image => <figure key={image.id} className="ai-image"><img src={image.url || `data:${image.mimeType};base64,${image.base64}`} alt={image.name || "用户附加图片"}/></figure>)}
        </div>;
        if (entry.action) return <div key={entry.id}>{renderAction?.(entry.action)}</div>;
        return <div key={entry.id} className="ai-response">{entry.card?.type === "text" && <div className="response-identity"><AgentIcon role="lake" size={18}/><strong>Lake</strong></div>}<Card card={entry.card!} tags={snapshot.session.tags}/></div>;
      })}
      <FileChanges cards={turn.flatMap(entry => entry.card && (entry.card.type === "diff" || entry.card.type === "operation" && ["write", "edit", "multi_edit", "append", "delete"].includes(entry.card.title || "")) ? [entry.card] : [])} resources={snapshot.resources ?? []} partial={index === 0 && before > 0}/>
      {turn.some(entry=>entry.message?.id===latestUser?.id) && snapshot.ai?.todos?.length ? <details className="ai-task-progress"><summary className="thinking-toggle">任务进度 {snapshot.ai.todos.filter(todo=>todo.status==="completed").length} / {snapshot.ai.todos.length}<span aria-hidden="true">›</span></summary><div>{snapshot.ai.todos.map((todo,i)=><div key={i}><span>{todo.status==="completed"?"✓":todo.status==="in_progress"?"进行中":"待处理"}</span> {todo.content}</div>)}</div></details> : null}
      <ReplyDuration timing={timingForTurn(turn,snapshot)} view={turn.some(entry=>entry.message?.id===latestUser?.id) ? snapshot.ai : undefined} cards={turn.flatMap(entry=>entry.card?[entry.card]:[])} latestUserAt={turn.find(entry=>entry.message?.role==="user")?.at??""}/>
    </div>)}

  </div>;
}
export function AIPending({ session, view, refresh, runId, agentName }: { session: string; view: AIView; refresh: () => Promise<unknown>; runId?: string; agentName?: string }) {
  const [confirmation, setConfirmation] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { setConfirmation(""); setError(""); }, [view.pending?.id]);
  const p = view.pending; if (!p) return null;
  const title = p.kind === "delete" ? "删除或移动操作需要确认" : p.risk === "dangerous" ? "危险操作需要确认目标" : ({mcp: "授权本次 MCP 操作", adopt_terminal: "授权访问其他会话的终端", resource_select: "确认本次操作的目标资源", terminal_open: "授权创建终端会话", file_read: "授权读取文件", file_write: "授权修改文件", resource_import: "确认导入资源", readonly_sql: "授权执行只读 SQL", command: "授权执行本次命令"} as Record<string, string>)[p.kind || ""] || "确认本次操作";
  const opening = p.kind === "terminal_open";
  const description = p.kind === "mcp" ? p.target : p.kind === "resource_import" ? `${p.target}。下列连接会立即加入资源列表；已有连接会跳过。` : p.kind === "resource_select" ? `当前会话有多个主机资源。请确认本次使用 ${p.target}${p.needsTerminal ? "，并创建该资源的终端" : ""}；也可以拒绝后在设置的会话配置中选择目标。` : opening && p.call.name === "inspect_host" ? `为 ${p.target} 创建持续终端，并读取系统、内存和进程状态。授权只覆盖本次创建；手动关闭后会重新申请。` : p.needsTerminal ? `为 ${p.target} 创建持续终端，并执行下面这一次操作。` : `${p.target} · ${p.call.name}`;
  const decide = async (accept: boolean) => { setBusy(true); setError(""); try { await api.aiOperation(session, runId ? "agentDecision" : "decision", { id: p.id, accept, confirmation, ...(runId ? {runId} : {}) }); await refresh(); } catch (error) { setError(readableError(error)); } finally { setBusy(false); } };
  let args: unknown = p.call.arguments; try { args = JSON.parse(p.call.arguments); } catch {}
  if(p.kind==="mcp"&&args&&typeof args==="object"&&"arguments" in args)args=(args as {arguments:unknown}).arguments;
  if(runId && args && typeof args === "object") args=Object.fromEntries(Object.entries(args).filter(([key])=>!["asset_ref","terminal_id","runtime"].includes(key)));
  return <section className="ai-pending" aria-label="Agent 操作确认"><strong>{agentName ? `${agentName} · ` : ""}{title}</strong><p>{description}</p>{p.resourceId && !runId && <p className="ai-approval-terminal">资源 ID：<code>{p.resourceId}</code></p>}{p.terminalId && <p className="ai-approval-terminal">执行终端：<code>{p.terminalId}</code></p>}{p.kind === "delete" && <p>移动到废纸篓、移动文件及删除都只授权本次操作；请核对下面的完整路径和命令。</p>}{!["inspect_host","import_resources"].includes(p.call.name) && <pre>{JSON.stringify(args, null, 2)}</pre>}{p.preview?.resources ? <ImportResourceRows rows={p.preview.resources}/> : p.preview && <div className="ai-diff-columns"><pre>{p.preview.before}</pre><pre>{p.preview.after}</pre></div>}{p.confirmation && <label>请输入「{p.confirmation}」<input value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off"/></label>}{error && <p role="alert">{error}</p>}<div className="ai-pending-actions"><button type="button" disabled={busy} onClick={() => void decide(false)}>拒绝</button><button type="button" disabled={busy || !!p.confirmation && confirmation !== p.confirmation} onClick={() => void decide(true)}>{busy ? "处理中…" : opening ? "允许创建并继续" : "确认并继续"}</button></div></section>;
}
export function AIControls({ snapshot, refresh, optionsOpen, onCloseOptions, permissionsOpen, permissionAnchor, onClosePermissions }: { snapshot: SessionSnapshot; refresh: () => Promise<unknown>; optionsOpen: boolean; onCloseOptions: () => void; permissionsOpen: boolean; permissionAnchor: RefObject<HTMLButtonElement | null>; onClosePermissions: () => void }) {
  const open = optionsOpen;
  const session = snapshot.session.id; const view = snapshot.ai!;
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [options, setOptions] = useState<Record<string, unknown>>({ profile: "core", runtime: "local", asset_ref: "", terminal_id: "", container_id: "", userPrompt: "", contextWindow: 64000, maxSteps: 500 });
  const [selectedPreset, setSelectedPreset] = useState(""); const [presets, setPresets] = useState<AIPreset[]>([]); const [presetTitle, setPresetTitle] = useState("");
  const running = view.status === "running" || view.status === "waiting_approval";
  useEffect(() => { let cancelled = false; setOptions({ profile: "core", runtime: "local", asset_ref: "", terminal_id: "", container_id: "", userPrompt: "", contextWindow: 64000, maxSteps: 500, ...permissionDefaults }); void Promise.all([api.aiOptions(session), api.aiPresets()]).then(([data, list]) => { if (!cancelled) { setOptions({ profile: "core", runtime: "local", asset_ref: "", terminal_id: "", container_id: "", userPrompt: "", contextWindow: 64000, maxSteps: 500, ...permissionDefaults, ...data }); setPresets(list); } }).catch(error => { if (!cancelled) setError(readableError(error)); }); return () => { cancelled = true; }; }, [session]);
  const work = async (fn: () => Promise<unknown>) => { setBusy(true); setError(""); try { await fn(); await refresh(); } catch (error) { setError(readableError(error)); } finally { setBusy(false); } };
  const selectTarget = (id: string) => { const resource = snapshot.resources.find(r => r.id === id); setOptions({ ...options, asset_ref: id, terminal_id: "", runtime: resource?.kind === "ssh" ? "ssh" : resource?.kind === "docker" ? "container" : "local" }); };
  return <>{error && <p className="form-error" role="alert">{error}</p>}{permissionsOpen && <PermissionSettings anchor={permissionAnchor} options={options} error={error} disabled={busy || running} onClose={onClosePermissions} onChange={(key, value) => void work(async () => { const saved = await api.aiOperation<Record<string, unknown>>(session, "configure", {[key]: value}); setOptions(current => ({...current, ...saved})); })}/>} {open && <div className="modal-scrim"><section className="ai-options modal" role="dialog" aria-modal="true" aria-label="会话配置"><div className="modal-header"><h2>会话配置</h2><button type="button" onClick={onCloseOptions} aria-label="关闭会话配置">关闭</button></div><ResourceMemory snapshot={snapshot} disabled={busy || running}/><AdoptTerminalPicker snapshot={snapshot} refresh={refresh} disabled={busy || running}/><label>多 Agent 调查<AppSelect value={String(options.multiAgentMode || "auto")} disabled={running} onChange={event => setOptions({ ...options, multiAgentMode: event.target.value })}><option value="auto">自动按需 · Scout / Trace / Deep / Beacon</option><option value="off">关闭 · Lake 独立处理</option></AppSelect></label><label>场景<AppSelect value={String(options.profile)} onChange={event => setOptions({ ...options, profile: event.target.value })}><option value="core">通用运维</option><option value="terminal2">当前终端</option><option value="db-query-editor">数据库查询</option></AppSelect></label><label>Shell / 文件目标<AppSelect value={String(options.asset_ref || "")} onChange={event => selectTarget(event.target.value)}><option value="">运行服务的本机</option>{snapshot.resources.filter(r => ["local", "ssh", "docker"].includes(r.kind)).map(resource => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</AppSelect></label>{options.runtime === "container" && <label>容器名称或 ID<input value={String(options.container_id || "")} onChange={event => setOptions({ ...options, container_id: event.target.value })}/></label>}<label>当前终端<AppSelect value={String(options.terminal_id || "")} onChange={event => { const t = snapshot.terminals.find(t => t.id === event.target.value); const r = snapshot.resources.find(r => r.id === t?.resourceId); setOptions({ ...options, terminal_id: event.target.value, ...(r ? { asset_ref: r.id, runtime: r.kind === "ssh" ? "ssh" : "local" } : {}) }); }}><option value="">未选择</option>{snapshot.terminals.filter(t => t.status !== "disconnected").map((t: TerminalSession) => <option value={t.id} key={t.id}>{snapshot.resources.find(r => r.id === t.resourceId)?.name} · 终端 {t.id.slice(0, 8)} · {t.holder === "agent" ? "Agent 持有" : "用户持有"}</option>)}</AppSelect></label><label>提示词预设<AppSelect defaultValue="" onChange={event => { setSelectedPreset(event.target.value); const p = presets.find(p => p.id === event.target.value); if (p) { setOptions({ ...options, userPrompt: p.content }); setPresetTitle(p.title); } }}><option value="">自定义</option>{presets.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</AppSelect></label><label>附加任务提示词<textarea rows={4} value={String(options.userPrompt || "")} onChange={event => setOptions({ ...options, userPrompt: event.target.value })}/></label><label>预设名称<input value={presetTitle} onChange={event => setPresetTitle(event.target.value)}/></label><div className="ai-option-row"><label>压缩预算（tokens）<input type="number" min={2048} max={2000000} value={Number(options.contextWindow)} onChange={event => setOptions({ ...options, contextWindow: Number(event.target.value) })}/></label><label>工具循环上限<input type="number" min={1} max={500} value={Number(options.maxSteps)} onChange={event => setOptions({ ...options, maxSteps: Number(event.target.value) })}/></label></div><div className="ai-option-buttons"><button disabled={busy || running} onClick={() => void work(() => api.aiOperation(session, "configure", options))}>保存会话配置</button><button disabled={busy || !presetTitle || !options.userPrompt} onClick={() => void work(async () => { await api.saveAIPreset({ title: presetTitle, content: String(options.userPrompt) }); setPresets(await api.aiPresets()); })}>保存为预设</button><button disabled={busy || !selectedPreset} onClick={() => void work(async () => { await api.deleteAIPreset(selectedPreset); setSelectedPreset(""); setPresets(await api.aiPresets()); })}>删除所选预设</button><button disabled={busy || running || !view.turns} onClick={() => void work(async () => { await api.aiOperation(session, "extractPreset"); setPresets(await api.aiPresets()); })}>从会话提取预设</button><button disabled={busy || running} onClick={() => void work(() => api.aiOperation(session, "compact"))}>压缩上下文</button><button disabled={busy || running || !view.turns} onClick={() => void work(() => api.aiOperation(session, "rollback"))}>回退一轮模型历史</button><button disabled={busy || running} onClick={() => void work(() => api.aiOperation(session, "undoFile"))}>恢复最近文件变更</button><button disabled={busy || running} onClick={() => void work(() => api.aiOperation(session, "clear"))}>清空模型上下文</button></div><p>回退历史不会撤销已执行命令。恢复文件前会检查内容是否被其他操作修改。</p></section></div>}{view.question && <AgentQuestion session={session} request={view.question} refresh={refresh}/>} {view.pending && <AIPending session={session} view={view} refresh={refresh}/>}</>;
}

export function ContextReferencePicker({ snapshot, onAdd }: { snapshot: SessionSnapshot; onAdd: (reference: Record<string, unknown>) => void }) {
 const [open, setOpen] = useState(false), [kind,setKind] = useState("file"), [resource,setResource] = useState(""), [path,setPath] = useState(""), [container,setContainer] = useState(""), [schema,setSchema] = useState("public"), [table,setTable] = useState(""), [terminal,setTerminal] = useState(""), [block,setBlock] = useState("");
 const [entries,setEntries] = useState<Array<{id:string;command:string}>>([]), [error,setError] = useState("");
 useEffect(() => { let cancelled=false; if(kind==="block"&&terminal) void api.terminalHistory(snapshot.session.id,terminal).then(history=>{if(!cancelled)setEntries(history.entries)}).catch(error=>{if(!cancelled)setError(readableError(error))});return()=>{cancelled=true}; },[kind,terminal,snapshot.session.id]);
 const selected = snapshot.resources.find(r=>r.id===resource);
 const add = () => { setError("");let ref:Record<string,unknown>;
   if(kind==="file"){if(!selected||!path.startsWith("/")||selected.kind==="docker"&&!container){setError("选择文件目标并填写绝对路径；容器目标还需要名称");return;}ref={kind:`file-${selected.kind==="docker"?"container":selected.kind}`,asset_ref:resource,path,container_id:container,label:path}}
   else if(kind==="db"){if(!selected||!schema||!table){setError("选择数据库并填写 schema / 表名");return;}ref={kind:"db-object",asset_ref:resource,schema,table,db:selected.settings?.database||"",label:`${selected.name} · ${schema}.${table}`}}
   else{if(!terminal||kind==="block"&&!block){setError("选择终端和命令记录");return;}ref={kind:kind==="block"?"terminal-command-block":"terminal-tab",terminal_id:terminal,block_id:block,label:kind==="block"?entries.find(e=>e.id===block)?.command||"命令记录":"当前终端"}}
   onAdd(ref);setOpen(false);
 };
 return <><button className="image-attach-button" type="button" onClick={()=>setOpen(true)}>引用上下文</button>{open&&<div className="modal-scrim"><section className="modal" role="dialog" aria-modal="true" aria-label="引用上下文"><h2>引用上下文</h2><label className="field-label">类型<AppSelect value={kind} onChange={e=>{setKind(e.target.value);setResource("")}}><option value="file">文件</option><option value="db">数据库表</option><option value="terminal">终端</option><option value="block">命令记录</option></AppSelect></label>{kind==="file"||kind==="db"?<><label className="field-label">资源<AppSelect value={resource} onChange={e=>setResource(e.target.value)}><option value="">选择会话资源</option>{snapshot.resources.filter(r=>kind==="db"?r.kind==="database":["local","ssh","docker"].includes(r.kind)).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</AppSelect></label>{kind==="file"?<><label className="field-label">文件绝对路径<input value={path} onChange={e=>setPath(e.target.value)} placeholder="/etc/nginx/nginx.conf"/></label>{selected?.kind==="docker"&&<label className="field-label">容器名称<input value={container} onChange={e=>setContainer(e.target.value)}/></label>}</>:<><label className="field-label">Schema / 命名空间<input value={schema} onChange={e=>setSchema(e.target.value)}/></label><label className="field-label">表名<input value={table} onChange={e=>setTable(e.target.value)}/></label></>}</>:<><label className="field-label">终端<AppSelect value={terminal} onChange={e=>{setTerminal(e.target.value);setBlock("")}}><option value="">选择终端</option>{snapshot.terminals.map(t=><option key={t.id} value={t.id}>{snapshot.resources.find(r=>r.id===t.resourceId)?.name} · 终端 {t.id.slice(0,8)} · {t.status}</option>)}</AppSelect></label>{kind==="block"&&<label className="field-label">命令记录<AppSelect value={block} onChange={e=>setBlock(e.target.value)}><option value="">选择命令</option>{entries.map(e=><option key={e.id} value={e.id}>{e.command}</option>)}</AppSelect></label>}</>}{error&&<p className="form-error">{error}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={()=>setOpen(false)}>取消</button><button type="button" className="button primary" onClick={add}>添加引用</button></div></section></div>}</>;
}

function ResourceMemory({snapshot,disabled}:{snapshot:SessionSnapshot;disabled:boolean}) {
 const [ids,setIds]=useState<string[]>([]),[error,setError]=useState("");
 useEffect(()=>{let cancelled=false;void api.referenceMemory(snapshot.session.id).then(ids=>{if(!cancelled)setIds(ids)}).catch(e=>{if(!cancelled)setError(readableError(e))});return()=>{cancelled=true}},[snapshot.session.id,snapshot.ai?.turns]);
 return <div><p>已记住的资源：{ids.map(id=>snapshot.resources.find(r=>r.id===id)?.name).filter(Boolean).join("、") || "无"}</p><button type="button" disabled={disabled||!ids.length} onClick={()=>void api.aiOperation(snapshot.session.id,"clearReferences").then(()=>setIds([])).catch(e=>setError(readableError(e)))}>清除资源访问记忆</button>{error&&<p role="alert">{error}</p>}</div>
}
function AdoptTerminalPicker({snapshot,refresh,disabled}:{snapshot:SessionSnapshot;refresh:()=>Promise<unknown>;disabled:boolean}) {
 const [list,setList]=useState<Array<TerminalSession & {ownerTitle:string}>>([]),[selected,setSelected]=useState(""),[error,setError]=useState("");
 useEffect(()=>{let cancelled=false;void api.availableTerminals(snapshot.session.id).then(value=>{if(!cancelled)setList(value.filter(t=>t.sessionId!==snapshot.session.id))}).catch(e=>{if(!cancelled)setError(readableError(e))});return()=>{cancelled=true}},[snapshot.session.id]);
 const term=list.find(t=>t.id===selected);
 return list.length ? <div><label>采用同项目其他会话的终端<AppSelect value={selected} onChange={e=>setSelected(e.target.value)}><option value="">选择明确终端</option>{list.map(t=><option key={t.id} value={t.id}>{t.ownerTitle} · {snapshot.resources.find(r=>r.id===t.resourceId)?.name} · {t.id.slice(0,8)} · {t.holder}</option>)}</AppSelect></label><p>授权允许访问选中终端，所有权和历史记录仍属于原会话。执行前须明确交给当前 Agent。</p><button type="button" disabled={disabled||!term} onClick={()=>void api.adoptTerminal(snapshot.session.id,term!.id,term!.generation,true).then(refresh).catch(e=>setError(readableError(e)))}>允许访问并绑定选中终端</button>{term&&<button type="button" disabled={disabled||term.status!=="ready"} onClick={()=>void api.terminalControl(snapshot.session.id,term.id,"agent").then(refresh).catch(e=>setError(readableError(e)))}>将选中终端交给当前 Agent</button>}{error&&<p role="alert">{error}</p>}</div> : null
}
