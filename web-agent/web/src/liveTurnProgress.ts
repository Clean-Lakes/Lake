import type {TranscriptEntry} from './timeline';
import {isAssistantProse} from './completedTurnProse';
import {resourceStagePreview} from './resourceStageProgress';
import {toolDescription} from './activity';

const normal=new Set(['running','completed','success','succeeded']);
const bookkeeping=new Set(['work_begin','work_read','work_update','work_wait','work_finish','__lake_apply_user_supplement']);
/** Ordinary live tool turns expose one real caption, not a generated summary.
 * Preserve the full prose/IDs for inspection and the final saved response. */
export function liveTurnProgress(turn:TranscriptEntry[]) {
 if(turn.some(entry=>entry.agentRun||entry.sre))return;
 const tools=turn.filter(entry=>entry.card&&['operation','shell'].includes(entry.card.type)&&entry.card.title!=='ask_user_question'&&!bookkeeping.has(entry.card.title??''));
 const latestTool=tools.at(-1)?.card;
 if(!latestTool)return;
 const lastTool=turn.lastIndexOf(tools.at(-1)!);
 // A later real tool proves a paragraph was narration. Text after the last
 // tool may already be a real answer and must stay in the main transcript.
 const prose=turn.filter((entry,index)=>index<lastTool&&isAssistantProse(entry)&&(!entry.card||normal.has(entry.card.status))&&resourceStagePreview(entry));
 const latest=prose.at(-1);
 const lastCard=turn.filter(entry=>entry.card&&entry.card.type!=='thinking').at(-1)?.card;
 return {text:latest?resourceStagePreview(latest):toolDescription(latestTool),ids:new Set(prose.map(entry=>entry.id)),active:!lastCard||normal.has(lastCard.status)};
}
