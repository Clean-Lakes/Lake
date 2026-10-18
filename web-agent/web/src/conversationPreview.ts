import type {TranscriptEntry} from './timeline';

/** Source for an excerpt of the recorded reply, never a newly generated summary
 * or a tool result. Commentary before a tool is not a final answer. */
export function conversationPreview(turn:TranscriptEntry[]):string {
 const candidates=turn.flatMap((entry,index)=>{
  if(entry.card&&['message','text'].includes(entry.card.type)&&!turn.slice(index+1).some(next=>next.card&&['operation','shell'].includes(next.card.type)))return [entry.card.content??''];
  if(entry.message?.role==='assistant')return [entry.message.text];
  if(entry.sre&&['summary','finding'].includes(entry.sre.entry.kind)){
   const attempt=entry.sre.task.attempts?.find(item=>item.id===entry.sre!.entry.attemptId);
   const text=attempt?.report?.summary||entry.sre.entry.body;
   return /^[\[{]/.test(text.trim())?[]:[text];
  }
  return [];
 });
 const text=candidates.filter(text=>text.trim()).at(-1)?.trim()??'';
 return text;
}

type PreviewNode={type:string;value?:string;children?:PreviewNode[]};
// Bound the rendered excerpt after parsing so truncation cannot expose half
// a bold/link delimiter or split a Unicode code point. Source is never edited.
export function remarkConversationExcerpt(){
 return (tree:PreviewNode)=>{
  let remaining=640;
  function visit(node:PreviewNode){
   if(node.value!==undefined){const chars=Array.from(node.value);node.value=chars.slice(0,remaining).join('');remaining=Math.max(0,remaining-chars.length)}
   if(node.children)node.children=node.children.filter(child=>{if(remaining<=0)return false;visit(child);return true});
  }
  visit(tree);
 };
}
