/** A reference is created by selection, rather than substring matching names. */
export type MentionKind = "resource" | "skill" | "mcp" | "role";
export type MentionReference = { resourceId: string; kind?: MentionKind; label: string; start: number; end: number };
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
  return [...new Set(references.filter(ref => (!ref.kind || ref.kind === "resource") && scope.includes(ref.resourceId) && text.slice(ref.start, ref.end) === ref.label).map(ref => ref.resourceId))];
}

export function referencedExtensions(text: string, references: MentionReference[]): Record<string, unknown>[] {
  const leading = text.length - text.trimStart().length;
  const seen = new Set<string>();
  return references.flatMap(ref => {
    if (!ref.kind || ref.kind === "resource" || text.slice(ref.start, ref.end) !== ref.label || seen.has(`${ref.kind}:${ref.resourceId}`)) return [];
    seen.add(`${ref.kind}:${ref.resourceId}`);
    return [{kind:ref.kind, [ref.kind === "skill" ? "skill_name" : ref.kind === "role" ? "role_id" : "server_id"]:ref.resourceId, label:ref.label, start:ref.start-leading, end:ref.end-leading}];
  });
}

/** Queue editing retains only selected, unchanged extension mentions. */
export function rebaseExtensionReferences(previous: string, next: string, references: Record<string, unknown>[]): Record<string, unknown>[] {
  return references.flatMap(ref => {
    if (ref.kind !== "skill" && ref.kind !== "mcp" && ref.kind !== "role") return [ref];
    if (typeof ref.start !== "number" || typeof ref.end !== "number" || typeof ref.label !== "string") return [];
    const rebased = rebaseMentions(previous,next,[{resourceId:"",label:ref.label,start:ref.start,end:ref.end}])[0];
    return rebased ? [{...ref,start:rebased.start,end:rebased.end}] : [];
  });
}
