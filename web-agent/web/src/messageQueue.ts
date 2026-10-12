/** Moves an item to an absolute queue position, preserving all other relative order. */
export function reorderQueuedMessages(ids: string[], id: string, position: number): string[] {
  if (!ids.includes(id) || !Number.isInteger(position) || position < 0 || position >= ids.length) return ids;
  const next=ids.filter(value => value!==id);
  next.splice(position,0,id);
  return next;
}
