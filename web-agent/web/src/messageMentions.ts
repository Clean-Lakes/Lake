import type {MessageMention,Resource} from "../../shared/contracts";
import {rebaseMentions} from "../../shared/references";
export type MessageTextPart = {text:string;mention?:MessageMention};

/** Explicit metadata wins, including an empty array for intentionally plain text. */
export function messageTextParts(text:string,mentions:MessageMention[]|undefined,resources:Pick<Resource,"id"|"name"|"kind">[]=[]):MessageTextPart[] {
 const candidates:MessageMention[]=[];
 if(mentions!==undefined){
  candidates.push(...mentions.filter(ref=>["resource","skill","mcp","role"].includes(ref.kind)&&!!ref.id&&Number.isInteger(ref.start)&&Number.isInteger(ref.end)&&ref.start>=0&&ref.end>ref.start&&ref.end<=text.length&&ref.label.startsWith('@')&&ref.label.length>1&&text.slice(ref.start,ref.end)===ref.label));
 }else{
  // Old messages saved only plain text. Match known full resource names, longest
  // first, without creating any new binding or changing the stored user text.
  const names=[...resources].filter(r=>!!r.name).sort((a,b)=>b.name.length-a.name.length);
  for(let i=0;i<text.length;i++){
   if(text[i]!=="@")continue;
   const resource=names.find(r=>text.startsWith('@'+r.name,i));
   if(!resource)continue;
   const end=i+resource.name.length+1;
   candidates.push({kind:"resource",id:resource.id,label:'@'+resource.name,start:i,end,resourceKind:resource.kind});i=end-1;
  }
 }
 const parts:MessageTextPart[]=[];
 let end=0;
 for(const ref of candidates.sort((a,b)=>a.start-b.start)){
  if(ref.start<end)continue;
  if(ref.start>end)parts.push({text:text.slice(end,ref.start)});
  parts.push({text:ref.label.slice(1),mention:ref});end=ref.end;
 }
 if(end<text.length||!parts.length)parts.push({text:text.slice(end)});
 return parts;
}
export function rebaseMessageMentions(previous:string,next:string,mentions:MessageMention[]):MessageMention[] {
 return mentions.flatMap(ref=>{
  const updated=rebaseMentions(previous,next,[{...ref,resourceId:ref.id}])[0];
  return updated?[{...ref,start:updated.start,end:updated.end}]:[];
 });
}
