import type { AICard, SessionSnapshot } from "../../shared/contracts";
import type { TranscriptEntry } from "./timeline";
import { compareTime } from "./timeline";

function turnId(card?:AICard) {
  const root=(card?.data as {root_turn_id?:unknown}|undefined)?.root_turn_id;
  return typeof root==="string" && root ? root : undefined;
}

/** These display cards exist only in the conversation. Activity and evidence
 * continue to use the original SDK stream, including all intermediate prose. */
export function workerTranscriptCards(snapshot:SessionSnapshot, cards:AICard[], before:number) {
  const reported=new Map<string,AICard>();
  const replies=snapshot.superagent?.deliveredReplies;
  if(snapshot.session.workspaceRole!=="worker" || !replies?.length)return {cards,reported};
  const loaded=new Set(cards.map(turnId));
  for(const message of replies){
    const author=message.author,root=author?.rootTurnId;
    if(!root || author.sessionId!==snapshot.session.id || (before>0 && !loaded.has(root) &&
        cards[0] && compareTime(message.createdAt,cards[0].at)<0))continue;
    reported.set(root,{id:message.id,type:"message",status:"completed",content:message.text,at:message.createdAt,
      data:{root_turn_id:root}});
  }
  const unique=cards.filter(card=>{
    const root=turnId(card),final=root && reported.get(root);
    return !final || !["text","message"].includes(card.type) || card.content?.trim()!==final.content?.trim();
  });
  return {cards:[...unique,...reported.values()],reported};
}

export function workerConversationTurns(turns:TranscriptEntry[][], reports:Map<string,AICard>) {
  if(!reports.size)return turns;
  return turns.flatMap(turn=>{
    const groups:TranscriptEntry[][]=[];
    let current:string|undefined;
    for(const entry of turn){
      const root=turnId(entry.card);
      if(!groups.length || (root && current && root!==current))groups.push([]);
      if(root)current=root;
      groups.at(-1)!.push(entry);
    }
    return groups;
  });
}

export function isDeliveredWorkerInterim(entry:TranscriptEntry, reports:Map<string,AICard>){
  const root=turnId(entry.card), delivered=root && reports.get(root);
  return !!delivered && entry.id!==delivered.id && (entry.card?.type==="text" || entry.card?.type==="message");
}
