/** A reference is created by selection, rather than substring matching names. */
export type MentionReference = { resourceId: string; label: string; start: number; end: number };
export function rebaseMentions(previous: string, next: string, references: MentionReference[]): MentionReference[] {
  let start = 0; while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let suffix = 0; while (suffix < previous.length - start && suffix < next.length - start && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
  const oldEnd = previous.length - suffix, delta = next.length - previous.length;
  return references.flatMap(ref => {
    const updated = ref.end <= start ? ref : ref.start >= oldEnd ? { ...ref, start: ref.start + delta, end: ref.end + delta } : null;
    return updated && next.slice(updated.start, updated.end) === updated.label ? [updated] : [];
  });
}
export function referencedResources(text: string, references: MentionReference[], scope: string[]): string[] {
  return [...new Set(references.filter(ref => scope.includes(ref.resourceId) && text.slice(ref.start, ref.end) === ref.label).map(ref => ref.resourceId))];
}
