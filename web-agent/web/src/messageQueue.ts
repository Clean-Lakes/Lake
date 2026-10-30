import type {MessageQueue,SessionSnapshot} from "../../shared/contracts";
/** Moves an item to an absolute queue position, preserving all other relative order. */
export function reorderQueuedMessages(ids: string[], id: string, position: number): string[] {
  if (!ids.includes(id) || !Number.isInteger(position) || position < 0 || position >= ids.length) return ids;
  const next=ids.filter(value => value!==id);
  next.splice(position,0,id);
  return next;
}

/** An admitted supplement is visible immediately, before the model's receipt. */
export function pendingUserSupplements(snapshot:SessionSnapshot) {
 const root=snapshot.ai?.rootTurnId,stored=new Set(snapshot.messages.map(message=>message.id));
 return (snapshot.messageQueue?.items??[]).filter(item=>!!root&&item.supplementRootTurnId===root&&!stored.has(item.id));
}
export function visibleQueuedMessages(queue:MessageQueue,root?:string) {
 return root?queue.items.filter(item=>item.supplementRootTurnId!==root):queue.items;
}
/** Reordering visible drafts must retain admitted supplements in the host queue. */
export function completeQueueOrder(queue:MessageQueue,visibleIDs:string[],root?:string):string[] {
 let index=0;
 return queue.items.map(item=>root&&item.supplementRootTurnId===root?item.id:visibleIDs[index++]!);
}
