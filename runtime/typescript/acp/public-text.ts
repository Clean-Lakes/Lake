import {createHash} from 'node:crypto';

const rawLimit=1024*1024,visibleLimit=32768;

/** ACP message identity bounds public prose; the run's audit text stays cumulative. */
export class ExternalPublicText {
 private text='';
 private messages=new Map<string,string>();
 constructor(private runId:string,private redact:(text:string,live?:boolean)=>string){}
 get auditText(){return this.text;}
 append(delta:string,messageId:unknown){
  // Share the existing run text budget rather than retaining an unbounded copy
  // for each message. No timing, punctuation or tool call guesses a boundary.
  const accepted=delta.slice(0,Math.max(0,rawLimit-this.text.length));
  this.text+=accepted;
  const known=typeof messageId==='string'&&!!messageId.trim()&&messageId.length<=512;
  const key=JSON.stringify(known?['message',this.runId,messageId]:['legacy',this.runId]);
  const current=known?(this.messages.get(key)??'')+accepted:this.text;
  if(known)this.messages.set(key,current);
  return {text:this.redact(this.text,true).slice(0,visibleLimit),
   publicText:this.redact(current,true).slice(0,visibleLimit),
   publicTextId:'acp_message_'+createHash('sha256').update(key).digest('hex')};
 }
}
