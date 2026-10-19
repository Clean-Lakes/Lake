import type {TranscriptEntry} from './timeline';
import {transcriptGroups} from './timeline';

export type ConversationGroup = {progress:boolean; entries:TranscriptEntry[]};

/** Each ordinary reply/operation owns a stable row. A later tool must never
 * absorb earlier prose into a replacing preview. Keep child-run dispatch and
 * controls grouped under their existing owner. */
export function conversationGroups(entries:TranscriptEntry[]):ConversationGroup[] {
 return transcriptGroups(entries).flatMap(group=>group.some(entry=>entry.agentRun)
  ? [{progress:false,entries:group}]
  : group.map(entry=>({progress:!!entry.card&&['operation','shell'].includes(entry.card.type),entries:[entry]})));
}
