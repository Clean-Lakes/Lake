import {memo} from 'react';
import Markdown,{type Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {AgentEvidence,SRERoleReport} from '../../shared/contracts';
import {Glyph} from './Icons';

// Component identity must survive live snapshots. Inline renderers remount
// tables/links on every update, losing DOM state and flashing the transcript.
const proseComponents:Components={a:({node,...props})=><a {...props} target="_blank" rel="noopener noreferrer"/>,table:({node,...props})=><div className="markdown-table-scroll"><table {...props}/></div>};
const prosePlugins=[remarkGfm];
export const SREProse=memo(function SREProse({children}:{children:string}){
 return <div className="sre-prose"><Markdown remarkPlugins={prosePlugins} skipHtml components={proseComponents}>{children}</Markdown></div>;
});

export function sreEvidenceText(text:string,evidence:AgentEvidence[]){
 return text.replace(/\bev_[a-f0-9]{32}\b/g,id=>{const i=evidence.findIndex(e=>e.id===id);return i>=0?`证据 ${i+1}`:'已记录证据'});
}

/** Retain older verbose replies verbatim, without inventing a short conclusion. */
export function SRECheckpoint({body}:{body:string}){
 if([...body].length<=360)return <SREProse>{body}</SREProse>;
 return <details className="sre-node-details"><summary>查看节点小结<Glyph name="chevron" size={13}/></summary><SREProse>{body}</SREProse></details>;
}

/** Present recorded report fields without inferring new findings or verification status. */
export function SREReport({report,evidence,onEvidence,compact=false}:{report:SRERoleReport;evidence:AgentEvidence[];onEvidence:(id:string)=>void;compact?:boolean}){
 const prose=(text:string)=><SREProse>{sreEvidenceText(text,evidence)}</SREProse>;
 const sections=[{title:'待验证假设',kind:'hypotheses',items:report.hypotheses},{title:'尚未确认',kind:'unknowns',items:report.unknowns},{title:'后续检查',kind:'next',items:report.nextChecks}];
 const hasDetails=!!(report.facts?.length||sections.some(s=>s.items?.length));
 const details=<>
  {!!report.facts?.length&&<section className="sre-report-section"><h4>观察事实 <span>{report.facts.length}</span></h4><ul className="sre-report-facts">{report.facts.map((fact,index)=><li key={index}>{prose(fact.statement)}<span className="sre-report-citations">{[...new Set(fact.evidenceIds??[])].map(id=>{const i=evidence.findIndex(e=>e.id===id);return i<0?null:<button type="button" key={id} className="sre-evidence-citation" onClick={()=>onEvidence(id)} aria-label={`查看证据 ${i+1}：${evidence[i]!.title}`}>证据 {i+1}</button>})}</span></li>)}</ul></section>}
  {sections.map(section=>!!section.items?.length&&<section className={`sre-report-section sre-report-${section.kind}`} key={section.kind}><h4>{section.title} <span>{section.items.length}</span></h4><ul>{section.items.map((text,index)=><li key={index}>{prose(text)}</li>)}</ul></section>)}
 </>;
 return <div className="sre-report">
  {report.summary?.trim()&&<div className="sre-report-summary">{compact?<SRECheckpoint body={sreEvidenceText(report.summary,evidence)}/>:prose(report.summary)}</div>}
  {compact&&hasDetails?<details className="sre-node-details"><summary>查看节点详情<Glyph name="chevron" size={13}/></summary>{details}</details>:details}
 </div>;
}
