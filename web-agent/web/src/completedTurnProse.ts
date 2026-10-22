import type {TranscriptEntry} from './timeline';

export function isAssistantProse(entry: TranscriptEntry): boolean {
  return entry.message?.role === 'assistant' || !!entry.card && ['message', 'text'].includes(entry.card.type);
}

// Only archive intermediate narration when the model actually supplied a final
// reply after its last tool call. Never synthesize a summary, hide an incomplete
// answer, cross user turns, or collapse the distinct reports of SRE roles.
export function completedTurnInterimIds(turn: TranscriptEntry[], completed: boolean): Set<string> {
  const ids = new Set<string>();
  if (!completed || turn.some(entry => entry.agentRun || entry.sre) || turn.filter(entry => entry.message?.role === 'user').length > 1) return ids;
  let lastTool = -1, final = -1;
  turn.forEach((entry, index) => {
    if (entry.card && ['operation', 'shell'].includes(entry.card.type)) lastTool = index;
    if (isAssistantProse(entry) && (entry.message?.text.trim() || entry.card?.status === 'completed' && entry.card.content?.trim())) final = index;
  });
  if (lastTool < 0) return ids;
  if (final <= lastTool || turn.slice(final + 1).some(entry => entry.card?.type === 'error' || entry.action)) return ids;
  for (const entry of turn.slice(0, lastTool)) {
    if (isAssistantProse(entry)) ids.add(entry.id);
  }
  return ids;
}
