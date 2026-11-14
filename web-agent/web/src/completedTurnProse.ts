import type {TranscriptEntry} from './timeline';

const normalProseStatuses = new Set(['running', 'completed', 'success', 'succeeded']);
const rootOf = (entry: TranscriptEntry): string | undefined => {
  const root = (entry.card?.data as {root_turn_id?: unknown} | undefined)?.root_turn_id;
  return typeof root === 'string' && root.trim() ? root : undefined;
};

export function isAssistantProse(entry: TranscriptEntry): boolean {
  return entry.message?.role === 'assistant' && !entry.message.author && !entry.message.dispatch || !!entry.card && ['message', 'text'].includes(entry.card.type);
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

// Archive only prose proven to precede a tool when an actual reply follows it
// in the same execution. Root-less legacy records use their complete user turn;
// mixed roots, dispatches and other speakers never bridge that boundary.
// An ended failed/stopped turn may still contain a real answer: retiring its
// pre-tool narration never changes the saved outcome or hides the later error.
// Never synthesize a summary, cross user turns or collapse distinct role reports.
export function completedTurnInterimIds(turn: TranscriptEntry[], completed: boolean, presentedReplyId?:string, ended=false): Set<string> {
  const ids = new Set<string>();
  if ((!completed&&!presentedReplyId&&!ended) || turn.some(entry => entry.agentRun || entry.sre) || turn.filter(entry => entry.message?.role === 'user').length > 1) return ids;
  const tools = turn.filter(entry => entry.card && ['operation', 'shell'].includes(entry.card.type) && entry.card.title !== 'ask_user_question');
  for (const root of new Set(tools.map(rootOf))) {
    const sameExecution = (entry: TranscriptEntry) => rootOf(entry) === root && (!!entry.card || root === undefined);
    const lastTool = turn.lastIndexOf(tools.filter(sameExecution).at(-1)!);
    let final = -1;
    turn.forEach((entry, index) => {
      if (sameExecution(entry) && isAssistantProse(entry) && (entry.message?.text.trim() ||
        (entry.card?.status === 'completed' || entry.id === presentedReplyId || ended) && entry.card?.content?.trim())) final = index;
    });
    if (final <= lastTool || !ended && turn.slice(final + 1).some(entry => entry.card?.type === 'error' || entry.action)) continue;
    for (const [index, entry] of turn.slice(0, lastTool).entries()) {
      if (!sameExecution(entry) || !isAssistantProse(entry) || entry.card && !normalProseStatuses.has(entry.card.status)) continue;
      if (turn.slice(index + 1, final).some(other => other.message?.author || other.message?.dispatch ||
        other.message?.role === 'system' || other.card && !sameExecution(other))) continue;
      ids.add(entry.id);
    }
  }
  return ids;
}
