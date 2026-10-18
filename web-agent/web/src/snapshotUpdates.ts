import type {SessionSnapshot} from '../../shared/contracts';

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
 return reuseUnchanged(previous,next);
}
