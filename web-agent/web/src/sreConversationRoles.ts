import type {TranscriptEntry} from './timeline';

// A presentation projection for one user turn. Audit/activity views keep the
// original entries, and different tasks never share a role's mutable surface.
export function sreConversationRoles(entries:TranscriptEntry[]){
 const output:TranscriptEntry[]=[],roles=new Map<string,number>();
 for(const item of entries){
  const sre=item.sre;
  if(!sre?.task.pilot||sre.entry.source==='user'){output.push(item);continue;}
  const key=JSON.stringify([sre.task.id,sre.entry.roleId]);
  const index=roles.get(key);
  if(index===undefined){roles.set(key,output.length);output.push({...item,sre:{...sre,thread:[sre.entry]}});continue;}
  const anchor=output[index]!;
  output[index]={...anchor,sre:{...sre,thread:[...anchor.sre!.thread!,sre.entry]}};
 }
 return output;
}
