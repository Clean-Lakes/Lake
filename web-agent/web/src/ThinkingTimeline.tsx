import type {ProgressResource} from './conversation-progress-model';
import {MiniBox} from './MiniBox';
import {isTerminalCommand,type MiniBoxScope} from './miniBoxModel';
import {ExecutionDetailsOpen} from './TurnExecutionDetails';
import {ExecutionIcon} from './ExecutionIcon';
import {DisclosureSummary} from './DisclosureSummary';
import { memo, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AICard } from "../../shared/contracts";
import { sameCard } from "./cardEquality";
import { processDescription, toolDescription, toolLabels } from "./activity";
export const ToolStep = memo(function ToolStep({ card, onInspect, active=false, hideTarget=false }: { card: AICard; onInspect?: () => void; active?:boolean; hideTarget?:boolean }) {
  const [open,setOpen]=useState(false);
  const data = card.data && typeof card.data === "object" ? card.data as Record<string, unknown> : {};
  const args = data.arguments && typeof data.arguments === "object" ? data.arguments as Record<string, unknown> : {};
  const state = card.status === "pending" ? "等待确认" : card.status === "background_running" ? "后台执行中" : card.status === "running" ? "执行中" : card.status === "failed" ? "失败" : card.status === "not_executed" ? "未执行" : ["interrupted", "cancelled"].includes(card.status) ? "已停止" : ["completed", "succeeded", "success"].includes(card.status) ? "已完成" : "结果待核查";
  const command = typeof args.command === "string" ? args.command : "";
  return <li className={`thinking-step thinking-tool step-${card.status}`}>
    <span className="thinking-step-marker"><ExecutionIcon card={card} active={active&&["running","completed","succeeded","success"].includes(card.status)} size={20}/></span>
    <details onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) onInspect?.(); }}>
      <summary><span className="thinking-tool-label">{toolLabels[card.title || ""] || card.title || "执行操作"}</span>{!hideTarget && typeof data.target === "string" && <span className="thinking-tool-target">{data.target}</span>}<small>{state}</small><svg className="thinking-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></summary>
      {open && <div className="thinking-tool-detail">
        {command ? <><strong>命令</strong><pre>{command}</pre></> : card.data != null && <><strong>调用参数</strong><pre>{JSON.stringify(data.arguments ?? card.data, null, 2)}</pre></>}
        {card.content && <><strong>结果</strong><pre>{card.content}</pre></>}
      </div>}
    </details>
  </li>;
}, (a, b) => sameCard(a.card, b.card) && a.active === b.active && a.hideTarget === b.hideTarget && a.onInspect === b.onInspect);

export const ReasonStep = memo(function ReasonStep({card}: {card: AICard}) {
  return card.content ? <li className="thinking-step thinking-reason"><span className="thinking-step-marker"><i/></span><div className="thinking-prose"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{a: props => <a {...props} target="_blank" rel="noopener noreferrer"/>}}>{card.content}</Markdown></div></li> : null;
}, (a, b) => sameCard(a.card, b.card));

export const ThinkingTimeline = memo(function ThinkingTimeline({ cards, live, onInspect, resourceRow=false, continuing=false, resource, stage,miniScope }: { cards: AICard[]; live: boolean; onInspect?: () => void; resourceRow?:boolean; continuing?:boolean; resource?:ProgressResource; stage?:ReactNode;miniScope?:MiniBoxScope }) {
  // A compact current-action line stays closed until the user requests details.
  const disclosureOpen=useContext(ExecutionDetailsOpen);
  const terminalKind=resource?.kind==='ssh'||resource?.kind==='local'?resource.kind:undefined;
  const miniCards=terminalKind&&resource?.id&&miniScope?cards.filter(isTerminalCommand):[];
  const [open, setOpen] = useState(!resourceRow&&disclosureOpen);
  const inspected=useRef(false),autoOpened=useRef(false);
  useEffect(()=>{
    if(!autoOpened.current&&!inspected.current&&live&&miniCards.length) {
      autoOpened.current=true;setOpen(true);
    }
  },[live,miniCards.length]);
  const [rawOpen, setRawOpen] = useState(false);
  const [commandsOpen,setCommandsOpen]=useState(false);
  const tools = cards.filter(card => card.type !== "thinking");
  const thoughts = cards.filter(card => card.type === "thinking" && card.content);
  const attention=tools.find(card=>!['running','completed','succeeded','success'].includes(card.status));
  const notices=[
    ['等待确认','pending'],['执行失败','failed'],['结果待核查','unknown'],['未执行','not_executed'],['已停止','interrupted','cancelled'],['后台执行中','background_running'],
  ].flatMap(([label,...statuses])=>{const count=tools.filter(card=>statuses.includes(card.status)).length;return count?[tools.length>1?`${count} 项${label}`:label]:[]});
  const state=notices.join(' · ')||(attention?'执行结果待核查':'');
  const currentTool=tools.filter(card=>card.status==='running').at(-1)??tools.at(-1);
  const description=resource?.name??(resourceRow&&currentTool?toolDescription(currentTool):processDescription(cards));
  const blocked=tools.some(card=>!['running','completed','succeeded','success'].includes(card.status));
  const executing=live&&!blocked&&cards.some(card=>card.status==='running');
  const progressing=live&&continuing&&!blocked&&tools.length>0;
  const iconActive=live&&!tools.some(card=>card.status==='pending')&&(currentTool
    ? ['running','completed','succeeded','success'].includes(currentTool.status)&&(currentTool.status==='running'||continuing)
    : executing);
  const label = [description,state].filter(Boolean).join(' · ');
  const panelId = `thinking-${cards[0]!.id}`;
  return <section className={`thinking-timeline ${resourceRow ? "is-resource-row" : ""} ${live ? "is-live" : ""} ${executing ? "is-executing" : ""} ${progressing ? "is-continuing" : ""}`} aria-label="思考与操作过程">
    <button type="button" className="thinking-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => { inspected.current=true;onInspect?.(); setOpen(!open); }}>
      <span className="thinking-process-icon"><ExecutionIcon card={currentTool} active={iconActive} resourceKind={resource?.kind}/></span><span className="thinking-label">{label}</span>{resourceRow&&tools.length>1&&<small className="thinking-operation-count">{tools.length} 项</small>}<svg className={`thinking-chevron ${open ? "is-open" : ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
    </button>
    {stage}
    {open && <div className="thinking-detail-panel" id={panelId}>
      {tools.length > 0 && <ol className="thinking-steps">{tools.map(card => miniCards.includes(card)?card.id===miniCards[0]!.id?<li className="thinking-step thinking-tool" key={card.id}><span className="thinking-step-marker"><ExecutionIcon card={card} size={20}/></span><MiniBox scope={miniScope!} resource={resource!.id!} kind={terminalKind!} cards={miniCards} onInspect={onInspect}/><details className="mini-box-audit" onToggle={event=>setCommandsOpen(event.currentTarget.open)}><DisclosureSummary>原始命令记录 · {miniCards.length}</DisclosureSummary>{commandsOpen&&<ol className="thinking-steps">{miniCards.map(item=><ToolStep card={item} key={item.id} hideTarget onInspect={onInspect}/>)}</ol>}</details></li>:null:<ToolStep card={card} key={card.id} active={iconActive&&currentTool?.id===card.id} hideTarget={!!resource} onInspect={onInspect}/>)}</ol>}
      {thoughts.length > 0 && <details className="thinking-raw-records" onToggle={event => setRawOpen(event.currentTarget.open)}><DisclosureSummary>原始思考记录</DisclosureSummary>{rawOpen && <ol className="thinking-steps">{thoughts.map(card => <ReasonStep card={card} key={card.id}/>)}</ol>}</details>}
    </div>}
  </section>;
}, (a, b) => a.miniScope === b.miniScope && a.stage === b.stage && a.resource?.id === b.resource?.id && a.resource?.name === b.resource?.name && a.resource?.kind === b.resource?.kind && a.resourceRow === b.resourceRow && a.continuing === b.continuing && a.live === b.live && a.onInspect === b.onInspect && a.cards.length === b.cards.length && a.cards.every((card, i) => sameCard(card, b.cards[i]!)));
