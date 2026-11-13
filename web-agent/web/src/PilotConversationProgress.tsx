import type {SpecialistConversation,SpecialistReplyAuthor} from '../../shared/contracts';
import {ReplyProcessStatus} from './ReplyProcessStatus';
import {ReplyIdentity} from './ReplyIdentity';

const labels={queued:'等待回应',running:'正在回复…',replied:'已回应',failed:'回应失败',timed_out:'回应超时',cancelled:'已停止',interrupted:'回应中断'} as const;
const roundLabels={queued:'正在召集',running:'等待回应',summarizing:'正在综合意见',completed:'',cancelled:'召集已停止',interrupted:'召集已中断',failed:'综合意见未完成'} as const;

export function PilotConversationProgress({rounds,connected=true,onSpecialist}:{rounds:SpecialistConversation[];connected?:boolean;onSpecialist?:(author:SpecialistReplyAuthor)=>void}){
 if(!rounds.length)return null;
 return <div className="pilot-conversation-progress" role="status" aria-live="polite" aria-label="干员回应进展">
  {rounds.map(round=>{
   const count=round.members.filter(member=>member.state==='replied').length;
   const active=connected&&['queued','running','summarizing'].includes(round.state);
   const label=connected?roundLabels[round.state]:'正在重连';
   return <div key={round.id} data-conversation-id={round.id} data-state={round.state}>
    <ReplyProcessStatus active={active} mark={active?'loading':round.state==='completed'&&count===round.members.length?'check':round.members.some(member=>['failed','timed_out','interrupted'].includes(member.state))?'alert':'clock'} className="pilot-conversation-status">{count} / {round.members.length} 位干员已回应{label&&` · ${label}`}</ReplyProcessStatus>
    {round.members.filter(member=>member.state!=='replied').map(member=>{
     const author:SpecialistReplyAuthor={kind:'specialist',name:member.roleName,roleId:member.roleId,workerId:member.id,sessionId:member.sessionId,channelSessionId:member.channelSessionId,conversationId:round.id,execution:member.execution,avatarId:member.avatarId};
     return <section className="ai-chat-message ai-role-assistant pilot-specialist-reply" key={member.id} data-role-id={member.roleId} data-state={member.state} title={member.reason}>
      <ReplyIdentity identity={{name:'Pilot',pilot:true}} author={author} authorMotion={connected&&member.state==='running'?'working':'still'} onSpecialist={onSpecialist}/>
      <ReplyProcessStatus active={connected&&member.state==='running'} mark={['failed','timed_out','interrupted'].includes(member.state)?'alert':member.state==='running'&&connected?'loading':'clock'}>{connected?labels[member.state]:'等待重新连接'}{member.reason&&member.state==='failed'?`：${member.reason}`:''}</ReplyProcessStatus>
     </section>;
    })}
   </div>;
  })}
 </div>;
}
