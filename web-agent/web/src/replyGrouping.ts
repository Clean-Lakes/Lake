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


/** Add breathing room at a real sender change, without splitting one sender's
 * continuation or treating an internal dispatch/tool packet as another role. */
export function replyRoleBreaks(turn:readonly TranscriptEntry[],hiddenProse:ReadonlySet<string>,hiddenProcess:ReadonlySet<string>=new Set()):Set<string>{
 const breaks=new Set<string>();let previous:string|undefined;
 for(const entry of turn){
  if(hiddenProse.has(entry.id)||hiddenProcess.has(entry.id)||entry.message?.dispatch)continue;
  if(entry.message?.role==='user'){previous=undefined;continue;}
  const author=entry.message?.author;
  const speaker=entry.message?.role==='assistant'&&entry.message.text.trim()?author?`role:${author.roleId??author.workerId}`:'pilot':
   entry.card&&['message','text'].includes(entry.card.type)&&entry.card.content?.trim()&&['running','completed','succeeded','success'].includes(entry.card.status)?'pilot':undefined;
  if(!speaker)continue;
  if(previous&&previous!==speaker)breaks.add(entry.id);
  previous=speaker;
 }
 return breaks;
}
