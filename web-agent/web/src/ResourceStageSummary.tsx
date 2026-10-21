import {useState,type ReactNode} from 'react';
import type {TranscriptEntry} from './timeline';
import {DisclosureSummary} from './DisclosureSummary';

/** Stable resource slot: new stage replaces the preview, prior stages are opt-in. */
export function ResourceStageSummary({entries,render}:{entries:TranscriptEntry[];render:(entry:TranscriptEntry)=>ReactNode}){
 const [historyOpen,setHistoryOpen]=useState(false);
 if(!entries.length)return null;
 const latest=entries.at(-1)!;
 return <div className="resource-stage-summary" aria-label="资源阶段结果">
  <div className="resource-stage-current" data-stage-entry={latest.id}>{render(latest)}</div>
  {entries.length>1&&<details className="resource-stage-history" onToggle={event=>setHistoryOpen(event.currentTarget.open)}><DisclosureSummary>此前进展 · {entries.length-1}</DisclosureSummary>{historyOpen&&entries.slice(0,-1).map(entry=><div className="resource-stage-record" key={entry.id}>{render(entry)}</div>)}</details>}
 </div>;
}
