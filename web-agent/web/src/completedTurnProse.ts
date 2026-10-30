import type {TranscriptEntry} from './timeline';

export function isAssistantProse(entry: TranscriptEntry): boolean {
  return entry.message?.role === 'assistant' || !!entry.card && ['message', 'text'].includes(entry.card.type);
}

// The latest reply after a tool may be the final answer. Keep its streaming node
// in the main body; only a subsequent tool proves that it was interim narration.
export function trailingTurnReplyId(turn:TranscriptEntry[]):string|undefined {
  if(turn.some(entry=>entry.agentRun||entry.sre))return;
  let lastTool=-1,reply=-1;
  turn.forEach((entry,index)=>{
    if(entry.card&&['operation','shell'].includes(entry.card.type))lastTool=index;
    if(isAssistantProse(entry)&&(entry.card?.content?.trim()||entry.message?.text.trim())&&(!entry.card||['running','completed','success','succeeded'].includes(entry.card.status)))reply=index;
  });
  if(lastTool<0||reply<=lastTool||turn.slice(reply+1).some(entry=>entry.action||entry.card?.type==='error'))return;
  return turn[reply]!.id;
}

// Archive only prose proven to precede a tool when an actual reply follows it.
// An ended failed/stopped turn may still contain a real answer: retiring its
// pre-tool narration never changes the saved outcome or hides the later error.
// Never synthesize a summary, cross user turns or collapse distinct role reports.
export function completedTurnInterimIds(turn: TranscriptEntry[], completed: boolean, presentedReplyId?:string, ended=false): Set<string> {
  const ids = new Set<string>();
  if ((!completed&&!presentedReplyId&&!ended) || turn.some(entry => entry.agentRun || entry.sre) || turn.filter(entry => entry.message?.role === 'user').length > 1) return ids;
  let lastTool = -1, final = -1;
  turn.forEach((entry, index) => {
    if (entry.card && ['operation', 'shell'].includes(entry.card.type)) lastTool = index;
    if (isAssistantProse(entry) && (entry.message?.text.trim() || (entry.card?.status === 'completed'||entry.id===presentedReplyId||ended) && entry.card?.content?.trim())) final = index;
  });
  if (lastTool < 0) return ids;
  if (final <= lastTool || !ended&&turn.slice(final + 1).some(entry => entry.card?.type === 'error' || entry.action)) return ids;
  for (const entry of turn.slice(0, lastTool)) {
    if (isAssistantProse(entry)) ids.add(entry.id);
  }
  return ids;
}
