import {DisclosureSummary} from './DisclosureSummary';
import {useState,type ReactNode} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {AICard} from '../../shared/contracts';
import {Glyph} from './Icons';
import {toolDescription} from './activity';
import {ToolStep,ReasonStep} from './ThinkingTimeline';
import {remarkAssistantProse} from './assistantProse';
import {useLineArrival} from './useLineArrival';

/** The fixed two-line preview replaces itself as work advances. All original
 * cards remain available, in order, in the explicitly expanded history. */
export function ConversationProgress({cards,live,onInspect,renderCard,restoredCardIds}:{cards:AICard[];live:boolean;restoredCardIds?:ReadonlySet<string>;onInspect?:()=>void;renderCard:(card:AICard)=>ReactNode}){
 const [open,setOpen]=useState(false);
 const tools=cards.filter(card=>['operation','shell'].includes(card.type));
 const latest=tools.at(-1)!;
 const narration=[...cards].reverse().find(card=>['message','text'].includes(card.type)&&!!card.content);
 const narrationLine=useLineArrival(narration?.id,live,!!restoredCardIds&&!!narration&&!restoredCardIds.has(narration.id));
 const actionLine=useLineArrival(latest.id,live,!!restoredCardIds&&!restoredCardIds.has(latest.id));
 const panelId=`progress-${cards[0]!.id}`;
 return <section className={`conversation-progress${live?' is-live':''}`} aria-label="执行过程">
  <button type="button" className="conversation-progress-toggle" aria-expanded={open} aria-controls={panelId} aria-label={`${open?'收起':'查看'}执行过程，${tools.length} 项操作`} onClick={()=>{onInspect?.();setOpen(!open)}}>
   <span className="conversation-progress-lines">
    <span className="conversation-progress-narration"><span ref={narrationLine}>{narration?<Markdown remarkPlugins={[remarkGfm,remarkAssistantProse]} skipHtml allowedElements={['p','strong','em','code','del']} unwrapDisallowed>{narration.content}</Markdown>:'执行过程'}</span></span>
    <span className="conversation-progress-action"><span ref={actionLine}>{toolDescription(latest)}</span></span>
   </span>
   <Glyph name="chevron" size={14} className={open?'is-open':''}/>
  </button>
  {open&&<div className="conversation-progress-history" id={panelId}>
   {cards.map(card=>['message','text'].includes(card.type)?<div className="ai-response" key={card.id}>{renderCard(card)}</div>:card.type==='thinking'?card.content&&<details className="thinking-raw-records" key={card.id}><DisclosureSummary>原始思考记录</DisclosureSummary><ol className="thinking-steps"><ReasonStep card={card}/></ol></details>:<ol className="thinking-steps" key={card.id}><ToolStep card={card} onInspect={onInspect}/></ol>)}
  </div>}
 </section>;
}
