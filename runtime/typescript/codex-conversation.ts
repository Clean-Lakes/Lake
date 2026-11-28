import {publicCommand} from './acp/codex-activity';
import {externalMessageId} from './acp/public-text';
import {activityCallStatus,updateCodexActivity,type CodexActivityItem} from '../../web-agent/shared/codex-activity';
import {isExternalAgentId} from '../../web-agent/shared/external-agents';
import type {AICard,SessionEvent} from '../../web-agent/shared/contracts';
import type {ExternalRun,ExternalEvent} from './acp/types';

function reportSubmitted(run:ExternalRun,event:ExternalEvent){
  return event.kind==='tool_update'&&event.title==='work_finish'&&event.status==='completed'&&
    !event.completionDeferred&&(run.agent==='codex'||event.toolSource==='lake-bridge');
}

function anonymousAntigravityMessageId(run:ExternalRun){
  if(run.agent==='antigravity'&&run.externalSessionId)return externalMessageId(run.id,run.externalSessionId);
}

/** Map closing prose to the public progress that preceded the submitted report. */
export function specialistClosingMessages(run:ExternalRun){
  const closing=new Map<string,string>();
  if(!isExternalAgentId(run.agent)||run.purpose!=='worker'||run.childSessionId||run.agentRunId||!run.rootTurnId)return closing;
  const finish=run.events.findIndex(event=>reportSubmitted(run,event));
  if(finish<0)return closing;
  const progress=new Map<string,string>(),anonymousId=anonymousAntigravityMessageId(run);
  for(const [index,event] of run.events.entries()){
    const id=event.publicTextId;
    if(event.kind!=='text'||!id)continue;
    if(index<finish)progress.set(id,event.publicText??'');
    else {
      const before=progress.get(id);
      if(before===undefined)closing.set(id,'');
      else if(id===anonymousId&&event.publicText?.startsWith(before))closing.set(id,before);
    }
  }
  return closing;
}

export function captureSpecialistActivity(run:ExternalRun,event:ExternalEvent,card:AICard):SessionEvent['textUpdate']|undefined {
  if(!isExternalAgentId(run.agent)||run.purpose!=='worker'||!run.rootTurnId||!run.taskId||run.childSessionId||run.agentRunId)return;
  const data=card.data as Record<string,unknown>;
  const items=(data.codex_activity??[]) as CodexActivityItem[];
  const antigravityPlan=run.agent==='antigravity'&&event.toolSource==='agent-plan'&&event.displayKind==='task'&&!!event.taskState;
  let item:CodexActivityItem;
  if(event.kind==='text'&&event.publicTextId&&typeof event.publicText==='string'){
    // Anonymous Antigravity chunks share one ID across progress and closing prose.
    // Keep the last progress text in the timeline once Lake accepts the report.
    if(event.publicTextId===anonymousAntigravityMessageId(run)&&
       run.events.some(earlier=>earlier.sequence<event.sequence&&reportSubmitted(run,earlier)))return;
    item={id:event.publicTextId,kind:'text',text:event.publicText};
  }else if((event.kind==='tool'||event.kind==='tool_update')&&event.displayKind&&event.callId&&
    (run.agent==='codex'||event.toolSource==='lake-bridge'||antigravityPlan)){
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
