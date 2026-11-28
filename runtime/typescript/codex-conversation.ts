import {publicCommand} from './acp/codex-activity';
import {activityCallStatus,updateCodexActivity,type CodexActivityItem} from '../../web-agent/shared/codex-activity';
import {isExternalAgentId} from '../../web-agent/shared/external-agents';
import type {AICard,SessionEvent} from '../../web-agent/shared/contracts';
import type {ExternalRun,ExternalEvent} from './acp/types';

/** A fresh message after the host accepted work_finish is closing prose.
 * Keep its audit events, and let the delivered report own the final paragraph. */
export function specialistClosingMessageIds(run:ExternalRun):string[]{
  if(!isExternalAgentId(run.agent)||run.purpose!=='worker'||run.childSessionId||run.agentRunId||!run.rootTurnId)return [];
  const finish=run.events.findIndex(e=>e.kind==='tool_update'&&e.title==='work_finish'&&e.status==='completed'&&
    (run.agent==='codex'||e.toolSource==='lake-bridge'));
  if(finish<0)return [];
  const progress=new Set<string>(),closing=new Set<string>();
  for(const [index,event] of run.events.entries()){
    if(event.kind!=='text'||!event.publicTextId)continue;
    if(index<finish)progress.add(event.publicTextId);
    else if(!progress.has(event.publicTextId))closing.add(event.publicTextId);
  }
  return [...closing];
}

export function captureSpecialistActivity(run:ExternalRun,event:ExternalEvent,card:AICard):SessionEvent['textUpdate']|undefined {
  if(!isExternalAgentId(run.agent)||run.purpose!=='worker'||!run.rootTurnId||!run.taskId||run.childSessionId||run.agentRunId)return;
  const data=card.data as Record<string,unknown>;
  const items=(data.codex_activity??[]) as CodexActivityItem[];
  let item:CodexActivityItem;
  if(event.kind==='text'&&event.publicTextId&&typeof event.publicText==='string'){
    item={id:event.publicTextId,kind:'text',text:event.publicText};
  }else if((event.kind==='tool'||event.kind==='tool_update')&&event.displayKind&&event.callId&&
    (run.agent==='codex'||event.toolSource==='lake-bridge')){
    const id=JSON.stringify([run.id,event.callId]);
    const old=items.find(entry=>entry.id===id&&entry.kind!=='text');
    const previous=old?.kind==='text'?undefined:old;
    const status=activityCallStatus(event.status);
    if(previous&&previous.status!=='running'&&status==='running')return;
    item={kind:event.displayKind,id,text:event.detail||previous?.text||'调用工具',status,at:previous?.at??event.at,
      ...((event.createdTask||event.title==='TaskCreate')&&{createdTask:true}),...(event.taskState&&{taskState:event.taskState}),
      output:event.preview??previous?.output,...(status!=='running'&&{endedAt:previous?.endedAt??event.at})};
  }else return;
  data.codex_activity=updateCodexActivity(items,item);
  return {target:'card',id:card.id,content:card.content??'',cardType:'operation',rootTurnId:run.rootTurnId,at:card.at,
    codexItem:item,codexTaskId:run.taskId,...(item.kind==='text'&&{externalReply:{id:item.id,content:item.text}})};
}

type ShellReceipt={at:string;completedAt:string;command:string};

/** The Lake MCP bridge generated its own call IDs in these older records. Only
 * use a receipt from the same frozen run that fits exactly one Bash call. */
export function legacyCommandBodies(run:ExternalRun,receipts:ShellReceipt[],redact:(s:string)=>string){
  const calls=new Map<string,{start?:ExternalEvent;end?:ExternalEvent;ambiguous?:boolean}>();
  for(const event of run.events){
    if(event.displayKind!=='command'||event.title!=='Bash'||!event.callId)continue;
    const call=calls.get(event.callId)??{};
    if(event.kind==='tool'&&event.status==='running'){
      if(call.start)call.ambiguous=true;
      call.start=event;
    }else if(event.kind==='tool_update'&&event.status!=='running'){
      if(call.end)call.ambiguous=true;
      call.end=event;
    }
    calls.set(event.callId,call);
  }
  const matched=new Map<string,string[]>();
  for(const receipt of receipts){
    if(!receipt.command||!receipt.at||receipt.at>receipt.completedAt)continue;
    const overlapping=[...calls].filter(([,call])=>(!call.start||call.start.at<=receipt.completedAt)&&(!call.end||receipt.at<=call.end.at));
    if(overlapping.length!==1)continue;
    const [id,call]=overlapping[0]!;
    if(call.ambiguous||!call.start||!call.end||call.start.at>receipt.at||receipt.completedAt>call.end.at)continue;
    const values=matched.get(id)??[];
    values.push(receipt.command);
    matched.set(id,values);
  }
  const bodies=new Map<string,string>();
  for(const [id,values] of matched){
    const old=calls.get(id)?.end?.detail;
    if(values.length===1&&(old==='内容已隐藏'||old?.length===240))
      bodies.set(JSON.stringify([run.id,id]),publicCommand(values[0]!,redact));
  }
  return bodies;
}
