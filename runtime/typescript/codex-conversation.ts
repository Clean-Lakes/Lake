import {updateCodexActivity,type CodexActivityItem} from '../../web-agent/shared/codex-activity';
import type {AICard,SessionEvent} from '../../web-agent/shared/contracts';
import type {ExternalRun,ExternalEvent} from './acp/types';

export function captureCodexActivity(run:ExternalRun,event:ExternalEvent,card:AICard):SessionEvent['textUpdate']|undefined {
  if(run.agent!=='codex'||run.purpose!=='worker'||!run.rootTurnId||!run.taskId||run.childSessionId||run.agentRunId)return;
  const data=card.data as Record<string,unknown>;
  const items=(data.codex_activity??[]) as CodexActivityItem[];
  let item:CodexActivityItem;
  if(event.kind==='text'&&event.publicTextId&&typeof event.publicText==='string'){
    item={id:event.publicTextId,kind:'text',text:event.publicText};
  }else if((event.kind==='tool'||event.kind==='tool_update')&&event.displayKind&&event.callId){
    const id=JSON.stringify([run.id,event.callId]);
    const old=items.find(entry=>entry.id===id&&entry.kind!=='text');
    const previous=old?.kind==='text'?undefined:old;
    const status=event.status==='running'?'running':event.status==='completed'?'completed':event.status==='failed'?'failed':
      ['cancelled','declined','interrupted'].includes(event.status??'')?'stopped':'unknown';
    if(previous&&previous.status!=='running'&&status==='running')return;
    item={kind:event.displayKind,id,text:event.detail||previous?.text||'调用工具',status,at:previous?.at??event.at,
      ...(event.title==='TaskCreate'&&{createdTask:true}),output:event.preview??previous?.output,...(status!=='running'&&{endedAt:previous?.endedAt??event.at})};
  }else return;
  data.codex_activity=updateCodexActivity(items,item);
  return {target:'card',id:card.id,content:card.content??'',cardType:'operation',rootTurnId:run.rootTurnId,at:card.at,
    codexItem:item,codexTaskId:run.taskId,...(item.kind==='text'&&{externalReply:{id:item.id,content:item.text}})};
}
