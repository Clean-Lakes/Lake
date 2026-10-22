import {memo} from 'react';
import type {AgentEvidence,SRERoleReport} from '../../shared/contracts';
import {AssistantMarkdown} from './AssistantMarkdown';

export const SREProse=memo(function SREProse({children}:{children:string;compact?:boolean}){
 return <div className="sre-prose"><AssistantMarkdown>{children}</AssistantMarkdown></div>;
});

export function sreEvidenceText(text:string,evidence:AgentEvidence[]){
 return text.replace(/\bev_[a-f0-9]{32}\b/g,id=>{const i=evidence.findIndex(e=>e.id===id);return i>=0?`证据 ${i+1}`:'已记录证据'});
}

/** Keep node replies complete; only operation records and evidence fold. */
export function SRECheckpoint({body}:{body:string}){
 return <SREProse>{body}</SREProse>;
}

/** Present recorded report fields without inferring new findings or verification status. */
export function SREReport({report,evidence,onEvidence}:{report:SRERoleReport;evidence:AgentEvidence[];onEvidence:(id:string)=>void;compact?:boolean}){
 const prose=(text:string)=><SREProse>{sreEvidenceText(text,evidence)}</SREProse>;
 const sections=[{title:'待验证假设',kind:'hypotheses',items:report.hypotheses},{title:'尚未确认',kind:'unknowns',items:report.unknowns},{title:'后续检查',kind:'next',items:report.nextChecks}];
 const details=<>
  {!!report.facts?.length&&<section className="sre-report-section"><h4>观察事实 <span>{report.facts.length}</span></h4><ul className="sre-report-facts">{report.facts.map((fact,index)=><li key={index}>{prose(fact.statement)}<span className="sre-report-citations">{[...new Set(fact.evidenceIds??[])].map(id=>{const i=evidence.findIndex(e=>e.id===id);return i<0?null:<button type="button" key={id} className="sre-evidence-citation" onClick={()=>onEvidence(id)} aria-label={`查看证据 ${i+1}：${evidence[i]!.title}`}>证据 {i+1}</button>})}</span></li>)}</ul></section>}
  {sections.map(section=>!!section.items?.length&&<section className={`sre-report-section sre-report-${section.kind}`} key={section.kind}><h4>{section.title} <span>{section.items.length}</span></h4><ul>{section.items.map((text,index)=><li key={index}>{prose(text)}</li>)}</ul></section>)}
 </>;
 return <div className="sre-report">
  {report.summary?.trim()&&<div className="sre-report-summary">{prose(report.summary)}</div>}
  {details}
 </div>;
}
