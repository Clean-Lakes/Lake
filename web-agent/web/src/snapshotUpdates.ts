import type {ConversationModeUpdate,SessionSnapshot} from '../../shared/contracts';

// Both the save response and the live event carry the same ordered mode delta.
// Keep every unrelated branch intact and reject replies from an older session
// revision (including a late save response after a newer mode event).
export function applyConversationMode(previous:SessionSnapshot|null,session:string,update:ConversationModeUpdate):SessionSnapshot|null {
 if(!previous||previous.session.id!==session||!Number.isSafeInteger(update.cursor)||update.cursor<previous.cursor)return previous;
 if(previous.conversationMode===update.mode&&previous.cursor===update.cursor)return previous;
 return {...previous,conversationMode:update.mode,cursor:update.cursor};
}

// Network JSON recreates every object. Retain unchanged branches so periodic
// catalog polling and activity-only snapshots do not repaint the conversation.
export function reuseUnchanged<T>(previous:T,next:T):T {
 if(Object.is(previous,next))return previous;
 if(!previous||!next||typeof previous!=='object'||typeof next!=='object'||Array.isArray(previous)!==Array.isArray(next))return next;
 const old=previous as Record<string,unknown>,fresh=next as Record<string,unknown>;
 const keys=Object.keys(fresh);
 let same=keys.length===Object.keys(old).length;
 const result:Record<string,unknown>|unknown[]=Array.isArray(next)?[]:{};
 for(const key of keys){
  const value=Object.hasOwn(old,key)?reuseUnchanged(old[key],fresh[key]):fresh[key];
  (result as Record<string,unknown>)[key]=value;
  if(!Object.hasOwn(old,key)||value!==old[key])same=false;
 }
 return same?previous:result as T;
}

export function acceptSnapshot(previous:SessionSnapshot|null,next:SessionSnapshot):SessionSnapshot {
 if(previous?.session.id!==next.session.id)return next;
 // A manual refresh can finish before an earlier SSE/poll request. Never
 // roll text, approvals, or task status back when that older response arrives.
 if(next.cursor<previous.cursor)return previous;
 // The backend sends a rolling page, not a deletion of previously displayed
 // history. Dropping its old prefix on every tool step changes scroll height
 // and remounts historical rows. Keep the visible page in this session snapshot;
 // incoming cards still replace matching IDs, including their latest outcomes.
 const before=previous.ai,after=next.ai;
 if(before&&after&&after.cardsOffset>before.cardsOffset&&after.cardsOffset<=before.cardsOffset+before.cards.length&&
    after.cardsOffset+after.cards.length>=before.cardsOffset+before.cards.length){
  const fresh=new Map(after.cards.map(card=>[card.id,card]));
  const seen=new Set(before.cards.map(card=>card.id));
  const cards=[...before.cards.map(card=>fresh.get(card.id)??card),...after.cards.filter(card=>!seen.has(card.id))];
  next={...next,ai:{...after,cards,cardsOffset:before.cardsOffset}};
 }
 return reuseUnchanged(previous,next);
}
