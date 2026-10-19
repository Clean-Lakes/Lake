import {DisclosureSummary} from './DisclosureSummary';
import { memo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AICard } from "../../shared/contracts";
import { sameCard } from "./cardEquality";
import { processDescription, toolDescription, toolLabels } from "./activity";
function StepIcon({ name }: { name?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    {name && /search|fetch|url/.test(name) ? <><circle cx="10" cy="10" r="6.5"/><path d="m15 15 6 6"/></> : name === "shell" || name === "terminal_read" ? <><path d="m4 6 5 5-5 5M12 17h8"/></> : <><rect x="4" y="4" width="16" height="6" rx="2"/><rect x="4" y="14" width="16" height="6" rx="2"/><path d="M7 7h1M7 17h1"/></>}
  </svg>;
}
export const ToolStep = memo(function ToolStep({ card, onInspect }: { card: AICard; onInspect?: () => void }) {
  const data = card.data && typeof card.data === "object" ? card.data as Record<string, unknown> : {};
  const args = data.arguments && typeof data.arguments === "object" ? data.arguments as Record<string, unknown> : {};
  const state = card.status === "pending" ? "等待确认" : card.status === "background_running" ? "后台执行中" : card.status === "running" ? "执行中" : card.status === "failed" ? "失败" : ["interrupted", "cancelled"].includes(card.status) ? "已停止" : ["completed", "succeeded", "success"].includes(card.status) ? "已完成" : "结果待核查";
  const command = typeof args.command === "string" ? args.command : "";
  return <li className={`thinking-step thinking-tool step-${card.status}`}>
    <span className="thinking-step-marker"><StepIcon name={card.title}/></span>
    <details onToggle={event => { if (event.currentTarget.open) onInspect?.(); }}>
      <summary><span className="thinking-tool-label">{toolLabels[card.title || ""] || card.title || "执行操作"}</span>{typeof data.target === "string" && <span className="thinking-tool-target">{data.target}</span>}<small>{state}</small><svg className="thinking-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></summary>
      <div className="thinking-tool-detail">
        {command ? <><strong>命令</strong><pre>{command}</pre></> : card.data != null && <><strong>调用参数</strong><pre>{JSON.stringify(data.arguments ?? card.data, null, 2)}</pre></>}
        {card.content && <><strong>结果</strong><pre>{card.content}</pre></>}
      </div>
    </details>
  </li>;
}, (a, b) => sameCard(a.card, b.card) && a.onInspect === b.onInspect);

export const ReasonStep = memo(function ReasonStep({card}: {card: AICard}) {
  return card.content ? <li className="thinking-step thinking-reason"><span className="thinking-step-marker"><i/></span><div className="thinking-prose"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{a: props => <a {...props} target="_blank" rel="noopener noreferrer"/>}}>{card.content}</Markdown></div></li> : null;
}, (a, b) => sameCard(a.card, b.card));

export const ThinkingTimeline = memo(function ThinkingTimeline({ cards, live, onInspect, resourceRow=false }: { cards: AICard[]; live: boolean; onInspect?: () => void; resourceRow?:boolean }) {
  // A compact current-action line stays closed until the user requests details.
  const [open, setOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const tools = cards.filter(card => card.type !== "thinking");
  const thoughts = cards.filter(card => card.type === "thinking" && card.content);
  const attention=tools.find(card=>!['running','background_running','completed','succeeded','success'].includes(card.status));
  const state=attention?.status==='pending'?'等待确认':attention?.status==='failed'?'执行失败':attention&&['interrupted','cancelled'].includes(attention.status)?'已停止':attention?'执行结果待核查':'';
  const description=resourceRow&&tools.length?toolDescription(tools.filter(card=>card.status==='running').at(-1)??tools.at(-1)!):processDescription(cards);
  const executing=live&&!attention&&tools.some(card=>card.status==='running');
  const label = [description,state].filter(Boolean).join(' · ');
  const panelId = `thinking-${cards[0]!.id}`;
  return <section className={`thinking-timeline ${resourceRow ? "is-resource-row" : ""} ${live ? "is-live" : ""} ${executing ? "is-executing" : ""}`} aria-label="思考与操作过程">
    <button type="button" className="thinking-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => { onInspect?.(); setOpen(!open); }}>
      <span className="thinking-label">{label}</span>{resourceRow&&tools.length>1&&<small className="thinking-operation-count">{tools.length} 项</small>}<svg className={`thinking-chevron ${open ? "is-open" : ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
    </button>
    {open && <div className="thinking-detail-panel" id={panelId}>
      {tools.length > 0 && <ol className="thinking-steps">{tools.map(card => <ToolStep card={card} key={card.id} onInspect={onInspect}/>)}</ol>}
      {thoughts.length > 0 && <details className="thinking-raw-records" onToggle={event => setRawOpen(event.currentTarget.open)}><DisclosureSummary>原始思考记录</DisclosureSummary>{rawOpen && <ol className="thinking-steps">{thoughts.map(card => <ReasonStep card={card} key={card.id}/>)}</ol>}</details>}
    </div>}
  </section>;
}, (a, b) => a.resourceRow === b.resourceRow && a.live === b.live && a.onInspect === b.onInspect && a.cards.length === b.cards.length && a.cards.every((card, i) => sameCard(card, b.cards[i]!)));
