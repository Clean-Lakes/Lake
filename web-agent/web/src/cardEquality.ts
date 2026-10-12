import type { AICard } from "../../shared/contracts";

// Snapshot JSON creates new objects even for completed cards. Comparing the
// small metadata lets React retain their already parsed Markdown trees.
export function sameCard(a: AICard, b: AICard): boolean {
  return a === b || a.id === b.id && a.type === b.type && a.title === b.title &&
    a.content === b.content && a.status === b.status && a.at === b.at &&
    (a.data === b.data || JSON.stringify(a.data) === JSON.stringify(b.data));
}
