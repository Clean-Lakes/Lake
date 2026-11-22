import {displayAiError,isContextCompactionFailure} from "./aiErrors";
import type { AICard, AgentRun, SessionSnapshot, SRETranscriptEntry } from "../../shared/contracts";
import { transcriptAgentRuns } from "./agentTasks";
import {sreEntries} from './sreTranscript';

export function compareTime(a: string, b: string): number {
  const millis = Date.parse(a) - Date.parse(b);
  if (millis) return millis;
  const fraction = (s: string) => Number((s.match(/\.(\d+)/)?.[1] ?? "").padEnd(9, "0").slice(0, 9));
  return fraction(a) - fraction(b);
}
export type TranscriptEntry = {
  at: string; id: string; card?: AICard;
  sourceMessageId?:string;
  separateIfUnbound?:boolean;
  message?: SessionSnapshot["messages"][number];
  action?: SessionSnapshot["actions"][number];
  agentRun?: AgentRun;
  sre?:ReturnType<typeof sreEntries>[number]&{thread?:SRETranscriptEntry[]};
};
export function replySourceMessageId(snapshot:SessionSnapshot){
 return snapshot.ai?.sourceMessageIds?.[0]??snapshot.messages.filter(message=>message.role==='user').at(-1)?.id;
}
function entrySource(entry:TranscriptEntry){
 const source=(entry.card?.data as {source_message_id?:unknown}|undefined)?.source_message_id;
 return entry.sourceMessageId??entry.message?.replyToMessageId??entry.message?.conversation?.sourceMessageId??(typeof source==='string'?source:undefined);
}
export function isCompactionFailureEntry(entry:Pick<TranscriptEntry,'card'|'message'>):boolean {
  const text=entry.card?.type==='error'?entry.card.content:entry.message?.role==='system'?entry.message.text:undefined;
  return !!text&&isContextCompactionFailure(text);
}
// Optional idle-resume maintenance is diagnostic metadata, not conversation.
// Match its host origin as well as the legacy text; quotations remain prose.
export function isCompactionFallbackEntry(entry: Pick<TranscriptEntry, 'card' | 'message'>): boolean {
  const content = entry.card?.type === 'notice' ? entry.card.content : entry.message?.role === 'system' ? entry.message.text : undefined;
  return content?.trim() === '历史上下文整理未完成，已保留原上下文继续本轮对话。';
}
// File summaries belong to the user turn that produced them, even when that
// turn includes several assistant replies and tool runs.
export function transcriptTurns(entries: TranscriptEntry[]): TranscriptEntry[][] {
  const turns: TranscriptEntry[][] = [];
  const sources=new Map<string,TranscriptEntry[]>();
  let current: TranscriptEntry[] | undefined;
  for (const entry of entries) {
    if (entry.message?.role === 'user') {
      current = [entry];
      turns.push(current);
      sources.set(entry.id, current);
      continue;
    }
    const owner = sources.get(entrySource(entry) ?? '');
    if (owner) owner.push(entry);
    else if (entry.separateIfUnbound) turns.push([entry]);
    else {
      if (!current) { current = []; turns.push(current); }
      current.push(entry);
    }
  }
  return turns;
}
export function orderedTranscript(snapshot: SessionSnapshot, cards: AICard[], before: number): TranscriptEntry[] {
  const earliest = cards[0]?.at ?? "";
  const earlierUser = snapshot.messages.filter(m => m.role === "user" && compareTime(m.createdAt, earliest) < 0).at(-1)?.id;
  const rootSources=new Map<string,string>();
  for(const card of cards){
    const data=card.data as {root_turn_id?:string;source_message_id?:string}|undefined;
    if(data?.root_turn_id&&typeof data.source_message_id==='string')rootSources.set(data.root_turn_id,data.source_message_id);
  }
  if(snapshot.ai?.rootTurnId&&snapshot.ai.sourceMessageIds?.[0])rootSources.set(snapshot.ai.rootTurnId,snapshot.ai.sourceMessageIds[0]);
  const sources=new Set([...rootSources.values(),...snapshot.messages.flatMap(message=>{
    const source=message.replyToMessageId??message.conversation?.sourceMessageId;
    return source?[source]:[];
  })]);
  const entries: TranscriptEntry[] = [
    ...snapshot.messages.filter(m => (before === 0 || compareTime(m.createdAt, earliest) >= 0 || m.id === earlierUser || sources.has(m.id))).map(message => ({
      at: message.createdAt, id: message.id, message,
      separateIfUnbound: snapshot.session?.workspaceRole === 'router' && !!message.author?.taskId && !message.conversation && !message.author.conversationId,
    })),
    ...cards.filter(card => card.type !== "compaction" && card.type !== "draft" && (!!card.content || ["operation", "chart", "diff", "image", "strategy_correction"].includes(card.type) || card.type === "thinking" && card.status === "running")).map(card => ({ at: card.at, id: card.id, card })),
    // The Go engine owns new tool cards. Keep earlier native approvals in their original turn.
    ...snapshot.actions.filter(action => (!snapshot.ai?.startedAt || compareTime(action.createdAt, snapshot.ai.startedAt) < 0) && (before === 0 || compareTime(action.createdAt, earliest) >= 0)).map(action => ({ at: action.createdAt, id: action.id, action })),
    ...transcriptAgentRuns(snapshot).filter(run => !run.sreTaskId&&(before === 0 || compareTime(run.createdAt, earliest) >= 0)).map(agentRun => ({ at: agentRun.createdAt, id: `agent:${agentRun.id}`, agentRun,sourceMessageId:agentRun.rootTurnId?rootSources.get(agentRun.rootTurnId):undefined })),
    ...sreEntries(snapshot).map(sre=>({at:sre.entry.createdAt,id:`sre:${sre.entry.id}`,sre})),
  ].sort((a, b) => compareTime(a.at, b.at));
  // Older persisted histories may contain the same fatal error as both an
  // engine card and a native system message. Keep the card in its own turn.
  return transcriptTurns(entries).flatMap(turn => turn.filter(entry => {
    const failure=entry.card?.type==='error'?entry.card.content:entry.message?.role==='system'?entry.message.text:undefined;
    if(failure&&turn.some(other=>{
      if(other.sre?.entry.kind!=='error'||displayAiError(other.sre.entry.body.trim())!==displayAiError(failure.trim()))return false;
      const attempt=other.sre.task.attempts?.find(a=>a.id===other.sre!.entry.attemptId&&a.roleRunId===other.sre!.entry.roleRunId);
      return Math.abs(Date.parse(attempt?.finishedAt||other.at)-Date.parse(entry.at))<5000;
    }))return false;
    // Only remove a native assistant copy when its actual reply card exists
    // in this turn. Server notices (including SRE scope questions) have no card.
    if (entry.message?.role === "assistant") {
      if(entry.message.author||entry.message.dispatch||entry.message.conversation||entry.message.jointReport?.kind==='summary')return true;
      const content=entry.message.text?.trim();
      return !content || !turn.some(other=>other.card && ["message","text"].includes(other.card.type) && other.card.content?.trim()===content);
    }
    if (entry.message?.role !== "system") return true;
    return !turn.some(other => other.card?.type === "error" && displayAiError(other.card.content || "") === displayAiError(entry.message!.text) && Math.abs(Date.parse(other.at) - Date.parse(entry.at)) < 5000);
  }));
}

// Thinking timelines never cross a reply, user turn, or an earlier native approval.
export function transcriptGroups(entries: TranscriptEntry[]): TranscriptEntry[][] {
  const stage = (entry: TranscriptEntry) => !!entry.agentRun || !!entry.card && ["thinking", "operation", "shell"].includes(entry.card.type);
  const groups: TranscriptEntry[][] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (stage(entry) && last && stage(last[last.length - 1]!)) last.push(entry);
    else groups.push([entry]);
  }
  return groups;
}
