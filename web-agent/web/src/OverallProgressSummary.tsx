import type {ReactNode} from 'react';
import type {TranscriptEntry} from './timeline';
import type {OverallProgress} from './overall-progress-model';

/** One factual summary slot; updates with tool states as well as stage prose. */
export function OverallProgressSummary({summary,render}:{summary:OverallProgress;render:(entry:TranscriptEntry)=>ReactNode}){
 return <div className="resource-stage-summary is-overall" aria-label="本轮进度">
  <p className="overall-progress-facts">{summary.facts}{summary.activity}</p>
  {summary.latest&&<div className="overall-progress-milestone" data-stage-entry={summary.latest.id}><span className="overall-progress-label">最新阶段：</span>{render(summary.latest)}</div>}
 </div>;
}
