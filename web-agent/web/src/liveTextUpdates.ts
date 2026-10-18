import type {SessionEvent,SessionSnapshot} from '../../shared/contracts';

// Live events address one item. They carry its received prefix, making replay,
// dropped packets and Unicode boundaries independent of network chunking.
// Snapshots remain authoritative for completion, approvals and reconnection.
export function applyLiveText(previous:SessionSnapshot|null,event:SessionEvent):SessionSnapshot|null {
 const update=event.textUpdate,ai=previous?.ai;
 if(!previous||previous.session.id!==event.sessionId||!ai||!update||typeof update.content!=='string'||!update.id)return null;
 if(event.seq<=previous.cursor)return previous;
 if(update.target==='agent'){
  const index=ai.agentRuns?.findIndex(run=>run.id===update.id)??-1;
  if(index<0||!update.textId)return null;
  const run=ai.agentRuns![index]!;
  if(run.status!=='running')return null;
  const agentRuns=ai.agentRuns!.map((item,i)=>i===index?{...item,liveText:update.content,liveTextId:update.textId}:item);
  return {...previous,cursor:event.seq,ai:{...ai,agentRuns}};
 }
 if(update.target!=='card'||!['message','thinking'].includes(update.cardType??'')||ai.status!=='running'||!update.rootTurnId||update.rootTurnId!==ai.rootTurnId)return null;
 const index=ai.cards.findIndex(card=>card.id===update.id);
 if(index<0&&!update.at)return null;
 if(index>=0&&ai.cards[index]!.status!=='running')return null;
 const cards=index<0?[...ai.cards,{id:update.id,type:update.cardType!,content:update.content,status:'running',at:update.at!}]:ai.cards.map((card,i)=>i===index?{...card,content:update.content}:card);
 return {...previous,cursor:event.seq,ai:{...ai,cards,totalCards:ai.totalCards+(index<0?1:0)}};
}
