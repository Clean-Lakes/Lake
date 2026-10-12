import {displayAiError} from "./aiErrors";
import type { AICard, SessionSnapshot } from "../../shared/contracts";

export function compareTime(a: string, b: string): number {
  const millis = Date.parse(a) - Date.parse(b);
  if (millis) return millis;
  const fraction = (s: string) => Number((s.match(/\.(\d+)/)?.[1] ?? "").padEnd(9, "0").slice(0, 9));
  return fraction(a) - fraction(b);
}
export type TranscriptEntry = {
  at: string; id: string; card?: AICard;
  message?: SessionSnapshot["messages"][number];
  action?: SessionSnapshot["actions"][number];
};
// File summaries belong to the user turn that produced them, even when that
// turn includes several assistant replies and tool runs.
export function transcriptTurns(entries: TranscriptEntry[]): TranscriptEntry[][] {
  const turns: TranscriptEntry[][] = [];
  for (const entry of entries) {
    if (!turns.length || entry.message?.role === "user") turns.push([]);
    turns.at(-1)!.push(entry);
  }
  return turns;
}
export function orderedTranscript(snapshot: SessionSnapshot, cards: AICard[], before: number): TranscriptEntry[] {
  const earliest = cards[0]?.at ?? "";
  const earlierUser = snapshot.messages.filter(m => m.role === "user" && compareTime(m.createdAt, earliest) < 0).at(-1)?.id;
  const entries: TranscriptEntry[] = [
    ...snapshot.messages.filter(m => (m.role !== "assistant" || !snapshot.ai?.startedAt || compareTime(m.createdAt, snapshot.ai.startedAt) < 0) && (before === 0 || compareTime(m.createdAt, earliest) >= 0 || m.id === earlierUser)).map(message => ({ at: message.createdAt, id: message.id, message })),
    ...cards.filter(card => card.type !== "compaction" && (!!card.content || ["operation", "chart", "diff", "image"].includes(card.type) || card.type === "thinking" && card.status === "running")).map(card => ({ at: card.at, id: card.id, card })),
    // The Go engine owns new tool cards. Keep earlier native approvals in their original turn.
    ...snapshot.actions.filter(action => (!snapshot.ai?.startedAt || compareTime(action.createdAt, snapshot.ai.startedAt) < 0) && (before === 0 || compareTime(action.createdAt, earliest) >= 0)).map(action => ({ at: action.createdAt, id: action.id, action })),
  ].sort((a, b) => compareTime(a.at, b.at));
  // Older persisted histories may contain the same fatal error as both an
  // engine card and a native system message. Keep the card in its own turn.
  return transcriptTurns(entries).flatMap(turn => turn.filter(entry => {
    if (entry.message?.role !== "system") return true;
    return !turn.some(other => other.card?.type === "error" && displayAiError(other.card.content || "") === displayAiError(entry.message!.text) && Math.abs(Date.parse(other.at) - Date.parse(entry.at)) < 5000);
  }));
}

// Thinking timelines never cross a reply, user turn, or an earlier native approval.
export function transcriptGroups(entries: TranscriptEntry[]): TranscriptEntry[][] {
  const stage = (entry: TranscriptEntry) => !!entry.card && ["thinking", "operation", "shell"].includes(entry.card.type);
  const groups: TranscriptEntry[][] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (stage(entry) && last && stage(last[last.length - 1]!)) last.push(entry);
    else groups.push([entry]);
  }
  return groups;
}
