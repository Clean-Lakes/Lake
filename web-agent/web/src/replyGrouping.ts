import type {TranscriptEntry} from './timeline';
import {isAssistantProse} from './completedTurnProse';

// Presentation only: preserve every reply and its original turn/author. The
// caller identifies process entries absent from the conversation body; visible
// questions, errors and specialist reports still break the sender group.
export function pilotReplyContinuations(turn:readonly TranscriptEntry[],hiddenProse:ReadonlySet<string>,hiddenProcess:ReadonlySet<string>=new Set()):Set<string> {
 const continuation=new Set<string>();
 let previous=false;
 for(const entry of turn){
  const prose=isAssistantProse(entry);
  if(prose&&hiddenProse.has(entry.id)||hiddenProcess.has(entry.id))continue;
  const visible=prose&&!!(entry.message?.text.trim()||entry.card?.content?.trim())
   &&(!entry.card||['running','completed','success','succeeded'].includes(entry.card.status));
  if(visible&&previous)continuation.add(entry.id);
  previous=visible;
 }
 return continuation;
}
