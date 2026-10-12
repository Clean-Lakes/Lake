import { diffLines } from "diff";
import type { AICard } from "../../shared/contracts";

export type LineDelta = { added: number; removed: number };
export type FileChange = {
  id: string; path: string; runtime: string; assetRef: string; containerId: string; target: string;
  before: string; after: string; existed: boolean; deleted: boolean; delta: LineDelta | null;
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
export function isFileChangeCard(card?: AICard): boolean {
  const data = record(card?.data);
  return card?.type === "diff" && card.status === "completed" && !!card.title && typeof data.before === "string" && typeof data.after === "string";
}
export function lineDelta(before: string, after: string): LineDelta | null {
  // Keep unusually expensive diffs from blocking a streaming conversation.
  const changes = diffLines(before, after, { timeout: 100 });
  if (!changes) return null;
  return changes.reduce((total, change) => ({ added: total.added + (change.added ? change.count : 0), removed: total.removed + (change.removed ? change.count : 0) }), { added: 0, removed: 0 });
}
export function summarizeFileChanges(cards: AICard[]): { files: FileChange[]; delta: LineDelta | null } {
  const files = new Map<string, FileChange>();
  const seen = new Set<string>();
  const operations = new Map<string, { runtime: string; assetRef: string; containerId: string; target: string }>();
  for (const card of cards) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    const data = record(card.data);
    if (card.type === "operation" && ["write", "edit", "multi_edit", "append", "delete"].includes(card.title || "")) {
      const args = record(data.arguments);
      operations.set(text(args.path), { runtime: text(args.runtime), assetRef: text(args.asset_ref), containerId: text(args.container_id), target: text(data.target) });
    }
    if (!isFileChangeCard(card)) continue;
    const path = card.title!;
    const legacy = operations.get(path);
    const identified = typeof data.runtime === "string";
    const runtime = text(data.runtime) || legacy?.runtime || "";
    const assetRef = identified ? text(data.assetRef) : legacy?.assetRef || "";
    const containerId = identified ? text(data.containerId) : legacy?.containerId || "";
    const target = text(data.target) || legacy?.target || "";
    // Legacy records lack target IDs, so retain their operation's target label.
    const id = JSON.stringify([runtime, assetRef, containerId, identified || assetRef ? "" : target, path]);
    const before = data.before as string, after = data.after as string;
    const previous = files.get(id);
    files.set(id, {
      id, path, runtime, assetRef, containerId, target,
      before: previous?.before ?? before, after,
      existed: previous?.existed ?? (typeof data.existed === "boolean" ? data.existed : before !== "" || after === ""),
      deleted: data.deleted === true, delta: null,
    });
  }
  const changed = [...files.values()].filter(file => file.before !== file.after || file.existed !== !file.deleted);
  let total: LineDelta | null = { added: 0, removed: 0 };
  for (const file of changed) {
    file.delta = lineDelta(file.before, file.after);
    if (!file.delta) total = null;
    else if (total) { total.added += file.delta.added; total.removed += file.delta.removed; }
  }
  return { files: changed, delta: total };
}
