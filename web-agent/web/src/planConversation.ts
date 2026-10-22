import type {TranscriptEntry} from './timeline';

function planEnvelope(text:string,streaming:boolean):{present:boolean;complete:boolean} {
 let fence='',start=-1,end=-1,invalid=false,partial=false;
 const lines=text.split('\n');
 for(let index=0;index<lines.length;index++){
  const line=lines[index]!.trim();
  if(fence){if(line.startsWith(fence)&&new RegExp(`^${fence[0]}+[ \\t\\r]*$`).test(line))fence='';continue;}
  const marker=line.match(/^(`{3,}|~{3,})/);
  if(marker){fence=marker[0];continue;}
  if(line==='<proposed_plan>'){if(start>=0)invalid=true;else start=index;}
  if(line==='</proposed_plan>'){if(start<0||end>=0)invalid=true;else end=index;}
  if(streaming&&index===lines.length-1&&line.startsWith('<')&&'<proposed_plan>'.startsWith(line))partial=true;
 }
 return {present:start>=0||partial,complete:start>=0&&end>start&&!invalid&&!!lines.slice(start+1,end).join('\n').trim()};
}

// Project before grouping, summaries and Markdown rendering. The full body
// stays in canonical history and the plan list, never in a hidden chat node.
export function conversationPlanEntry(entry:TranscriptEntry,{planMode,live,currentPlanId}:{planMode:boolean;live:boolean;currentPlanId?:string}):TranscriptEntry {
 const card=entry.card;
 if(!card&&entry.message?.role!=='assistant'||card&&!['message','text'].includes(card.type))return entry;
 const data=card?.data&&typeof card.data==='object'?card.data as Record<string,unknown>:{};
 const writing=live&&card?.status==='running';
 const envelope=planEnvelope(card?.content??entry.message?.text??'',!!writing&&planMode);
 if(data.proposedPlan!==true&&currentPlanId!==entry.id&&!envelope.present)return entry;
 const saved=data.proposedPlan===true||currentPlanId===entry.id||card?.status==='completed'&&envelope.complete;
 return {id:entry.id,at:entry.at,card:{id:entry.id,at:entry.at,type:'plan_reference',content:'',status:card?.status??'completed',data:{state:saved?'saved':writing?'writing':'incomplete'}}};
}
