import {useId,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import type {SpecialistConversation,SpecialistConversationMember,SpecialistReplyAuthor} from '../../shared/contracts';
import {Glyph} from './Icons';
import {SuperRoleAvatar} from './SuperRoleAvatar';

const memberLabels={queued:'排队',running:'回复中',replied:'已回复',failed:'回应失败',timed_out:'回应超时',cancelled:'已停止',interrupted:'回应中断'};
type Pane='replies'|'waiting'|null;

function Participants({members,roundId,onSpecialist}:{members:readonly SpecialistConversationMember[];roundId:string;onSpecialist?:(author:SpecialistReplyAuthor)=>void}) {
  return <ul className="pilot-conversation-participants">{members.map(member=>{
    const detail=member.reason??memberLabels[member.state];
    const name=<><SuperRoleAvatar name={member.roleName} roleId={member.roleId} avatarId={member.avatarId} size={20}/><span>{member.roleName}</span></>;
    return <li key={member.id} data-state={member.state}>
      {onSpecialist?<button type="button" onClick={()=>onSpecialist({kind:'specialist',name:member.roleName,roleId:member.roleId,
        workerId:member.id,sessionId:member.sessionId,channelSessionId:member.channelSessionId,conversationId:roundId,execution:member.execution,avatarId:member.avatarId})}>{name}</button>:<span>{name}</span>}
      {member.state!=='running'&&member.state!=='queued'&&<small>{detail}</small>}
    </li>;
  })}</ul>;
}

export function PilotConversationProgress({round,replies,process,connected=true,onSpecialist,onInspect}:{
  round:SpecialistConversation;
  replies:readonly ReactNode[];
  process?:ReactNode;
  connected?:boolean;
  onSpecialist?:(author:SpecialistReplyAuthor)=>void;
  onInspect?:()=>void;
}) {
  const id=useId(), body=useRef<HTMLDivElement>(null);
  const [pane,setPane]=useState<Pane>();
  const live=['queued','running','summarizing'].includes(round.state);
  const running=round.members.filter(member=>member.state==='running');
  const reported=round.members.filter(member=>member.state==='replied');
  const queued=round.members.filter(member=>member.state==='queued');
  const missing=round.members.filter(member=>!['queued','running','replied'].includes(member.state));
  const pending=[...queued,...missing];
  const shown=running.length?running:reported;
  const headline=running.length?`${running.length} 位回复中`:reported.length||!live?`${reported.length} 份专员报告`:'正在召集';
  const waitingLabel=[queued.length?`${queued.length} 位排队`:'',missing.length?`${missing.length} 位未回应`:''].filter(Boolean).join(' · ');
  const state=!connected&&live?'正在重连':round.state==='summarizing'?'Pilot 正在总结':round.state==='cancelled'?'召集已停止':round.state==='interrupted'?'召集已中断':undefined;
  const visibleBody=body.current;
  const selection=!live&&pane===undefined&&visibleBody?window.getSelection():null;
  const keepReading=!live&&pane===undefined&&!!visibleBody&&(visibleBody.contains(document.activeElement)||
    visibleBody.contains(selection?.anchorNode??null)||visibleBody.contains(selection?.focusNode??null));
  const repliesOpen=pane==='replies'||pane===undefined&&(live&&replies.length>0||keepReading);
  const waitingOpen=pane==='waiting';
  useLayoutEffect(()=>{if(keepReading)setPane('replies');},[keepReading]);
  const toggle=(next:Exclude<Pane,null>,open:boolean)=>{onInspect?.();setPane(open?null:next);};
  const status=<>
    {!!shown.length&&<span className="pilot-conversation-avatars" aria-hidden="true">
      {shown.slice(0,3).map(member=><span className="pilot-conversation-avatar" key={member.id} title={member.roleName}>
        <SuperRoleAvatar name={member.roleName} roleId={member.roleId} avatarId={member.avatarId} size={20} motion={connected&&member.state==='running'?'working':'still'}/>
      </span>)}
      {shown.length>3&&<span className="pilot-conversation-overflow">+{shown.length-3}</span>}
    </span>}
    <span>{headline}</span>
  </>;
  return <section className="pilot-conversation-progress" aria-label="专员协作" data-conversation-id={round.id} data-state={round.state}>
    <div className="pilot-conversation-bar">
      {shown.length>0||replies.length>0?<button type="button" className="pilot-conversation-toggle" data-active={connected&&running.length>0||undefined}
        aria-expanded={repliesOpen} aria-controls={`${id}-replies`} aria-describedby={shown.length?`${id}-speakers`:undefined} onClick={()=>toggle('replies',repliesOpen)}>
        {status}<Glyph name="next" size={12} className="pilot-conversation-chevron"/>
      </button>:<span className="pilot-conversation-static">{status}</span>}
      {shown.length>0&&<span className="visually-hidden" id={`${id}-speakers`}>{shown.map(member=>member.roleName).join('、')}</span>}
      {(waitingLabel||waitingOpen)&&<button type="button" className="pilot-conversation-toggle is-secondary" data-missing={missing.length>0||undefined}
        aria-expanded={waitingOpen} aria-controls={`${id}-waiting`} onClick={()=>toggle('waiting',waitingOpen)}>
        {waitingLabel||'排队情况'}<Glyph name="next" size={12} className="pilot-conversation-chevron"/>
      </button>}
      {running.length>0&&reported.length>0&&<span className="pilot-conversation-meta">{reported.length} 份已收到</span>}
      {state&&<span className="pilot-conversation-meta" role="status">{state}</span>}
      {process&&<div className="pilot-conversation-process">{process}</div>}
    </div>
    <div id={`${id}-replies`} hidden={!repliesOpen}>
      <div ref={body} className="pilot-conversation-replies">{replies}</div>
      {repliesOpen&&!replies.length&&<Participants members={shown} roundId={round.id} onSpecialist={onSpecialist}/>}
    </div>
    <div id={`${id}-waiting`} hidden={!waitingOpen}>
      {pending.length>0?<Participants members={pending} roundId={round.id} onSpecialist={onSpecialist}/>:<p className="pilot-conversation-meta">当前没有排队专员</p>}
    </div>
  </section>;
}
