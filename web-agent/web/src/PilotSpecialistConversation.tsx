import {useEffect,useState} from 'react';
import type {SessionEvent,SessionSnapshot,SpecialistReplyAuthor} from '../../shared/contracts';
import {api} from './api';
import {applyLiveText} from './liveTextUpdates';
import {pilotSpecialistReply,specialistSnapshotMatches,type PilotSpecialistRow} from './pilotSpecialistReplies';
import {ReplyIdentity} from './ReplyIdentity';
import {AssistantMarkdown} from './AssistantMarkdown';
import {LoadingWaves} from './LoadingWaves';
import {usePageVisible} from './usePageVisible';
import {useSmoothText} from './useSmoothText';
import {conversationPlanEntry} from './planConversation';
import {PlanReference} from './PlanMode';

function useSpecialistReply(row:PilotSpecialistRow,connected:boolean,visible:boolean){
 const binding=JSON.stringify([row.projectId,row.worker.id,row.worker.roleId,row.worker.sessionId,row.worker.task.taskId,row.worker.task.executionGoalId,row.sourceMessageId]);
 const [state,setState]=useState<{binding:string;snapshot?:SessionSnapshot;failed:boolean}>();
 useEffect(()=>{
  if(!connected||!visible)return;
  const controller=new AbortController();let disposed=false,busy=false,queued=false,healthy=false;
  let latest=state?.binding===binding?state.snapshot:undefined,frame:number|undefined,timer:ReturnType<typeof setTimeout>|undefined,stream:EventSource|undefined;
  let events:SessionEvent[]=[];
  const refresh=async()=>{
   if(busy){queued=true;return;}busy=true;
   try{
    const next=await api.snapshot(row.worker.sessionId,controller.signal,row.worker.task.executionGoalId??row.worker.task.taskId);
    if(disposed)return;
    if(!specialistSnapshotMatches(row,next)){latest=undefined;setState({binding,failed:true});return;}
    if(!latest||next.cursor>=latest.cursor){latest=next;healthy=stream?.readyState===1;setState({binding,snapshot:next,failed:false});}
   }catch{if(!disposed){healthy=false;setState({binding,snapshot:latest,failed:true});}}
   finally{busy=false;if(queued&&!disposed){queued=false;void refresh();}}
  };
  const schedule=()=>{if(!timer)timer=setTimeout(()=>{timer=undefined;void refresh();},100);};
  const receive=(incoming:MessageEvent<string>)=>{
   try{
    const event=JSON.parse(incoming.data) as SessionEvent;
    if(event.sessionId!==row.worker.sessionId||typeof event.seq!=='number'||latest&&event.seq<=latest.cursor)return;
    if(event.textUpdate&&applyLiveText(latest??null,event)){
     events.push(event);
     if(frame===undefined)frame=requestAnimationFrame(()=>{
      frame=undefined;if(disposed)return;
      for(const item of events)latest=applyLiveText(latest??null,item)??latest;
      events=[];setState({binding,snapshot:latest,failed:false});
     });
    }else schedule();
   }catch{schedule();}
  };
  void refresh();
  stream=typeof EventSource==='undefined'?undefined:new EventSource(api.eventsUrl(row.worker.sessionId,latest?.cursor??0),{withCredentials:true});
  if(stream){
   stream.onopen=()=>{healthy=true;void refresh();};
   stream.onerror=()=>{healthy=false;setState({binding,snapshot:latest,failed:true});void refresh();};
   stream.onmessage=receive;
   for(const type of ['session','specialist'])stream.addEventListener(type,receive as EventListener);
  }
  const poll=setInterval(()=>{if(!healthy)void refresh();},2000);
  return()=>{disposed=true;controller.abort();stream?.close();clearInterval(poll);if(timer)clearTimeout(timer);if(frame!==undefined)cancelAnimationFrame(frame);};
 },[binding,connected,visible]);
 return state?.binding===binding?state:undefined;
}

function PilotSpecialistReply({row,onSpecialist,connected}:{row:PilotSpecialistRow;onSpecialist?: (author:SpecialistReplyAuthor)=>void;connected:boolean}){
 const visible=usePageVisible(),state=useSpecialistReply(row,connected,visible),entry=pilotSpecialistReply(row,state?.snapshot);
 const available=connected&&!state?.failed;
 const moving=available&&['thinking','tool'].includes(row.activity.phase)&&(!state?.snapshot||state.snapshot.ai?.status==='running');
 const projected=entry?.card?conversationPlanEntry({id:entry.card.id,at:entry.createdAt,card:entry.card},{planMode:state?.snapshot?.conversationMode==='plan',live:moving,currentPlanId:state?.snapshot?.ai?.proposedPlan?.id}):undefined;
 const text=useSmoothText(projected?.card?.type==='plan_reference'?'':entry?.card?.content??'',moving&&visible);
 if(entry?.reply&&row.reportedTurns.includes(entry.reply.turnId))return null;
 const label=available?row.activity.label:'进度暂未更新，正在重连';
 return <section className="ai-chat-message ai-role-assistant pilot-specialist-reply" data-worker-id={row.worker.id} data-task-id={row.worker.task.taskId} data-phase={row.activity.phase} aria-label={`${row.author.name}的回复`}>
  <ReplyIdentity identity={{name:'Pilot',pilot:true}} author={row.author} authorMotion={moving?'working':'still'} onSpecialist={onSpecialist}/>
  {projected?.card?.type==='plan_reference'?<PlanReference state={(projected.card.data as {state:'saved'|'writing'|'incomplete'}).state}/>:text?<div className="ai-card ai-message"><AssistantMarkdown>{text}</AssistantMarkdown></div>:<div className="pilot-specialist-waiting" role="status">{moving&&visible&&<LoadingWaves/>}<span>{label}</span></div>}
  {text&&!available&&<small className="pilot-specialist-connection" role="status">进度暂未更新，正在重连</small>}
 </section>;
}

export function PilotSpecialistConversation({rows,onSpecialist,connected=true}:{rows:PilotSpecialistRow[];onSpecialist?: (author:SpecialistReplyAuthor)=>void;connected?:boolean}){
 if(!rows.length)return null;
 return <div className="pilot-specialist-conversation">{rows.map(row=><PilotSpecialistReply key={row.worker.id} row={row} onSpecialist={onSpecialist} connected={connected}/>)}</div>;
}
