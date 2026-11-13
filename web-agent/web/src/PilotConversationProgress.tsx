import type {SpecialistConversation,SpecialistReplyAuthor} from '../../shared/contracts';
import {Glyph} from './Icons';
import {LoadingWaves} from './LoadingWaves';
import {StatusText} from './StatusText';
import {ReplyIdentity} from './ReplyIdentity';

const labels={queued:'尚未回应，等待唤醒',running:'尚未回应，正在回复',replied:'已回应',failed:'回应失败',timed_out:'未回应，等待超时',cancelled:'已停止',interrupted:'回应中断'} as const;
const roundLabels={queued:'正在召集',running:'等待干员回应',summarizing:'Pilot 正在汇总',completed:'Pilot 已汇总',cancelled:'召集已停止',interrupted:'召集已中断',failed:'Pilot 汇总未完成'} as const;

export function PilotConversationProgress({rounds,connected=true,onSpecialist}:{rounds:SpecialistConversation[];connected?:boolean;onSpecialist?:(author:SpecialistReplyAuthor)=>void}){
 if(!rounds.length)return null;
 return <div className="pilot-conversation-progress" role="status" aria-live="polite" aria-label="干员回应进展">
  {rounds.map(round=>{
   const count=round.members.filter(member=>member.state==='replied').length;
   const active=connected&&['queued','running','summarizing'].includes(round.state);
   return <div key={round.id} data-conversation-id={round.id} data-state={round.state}>
    <div className="pilot-conversation-status">
     {active?<LoadingWaves/>:<Glyph name={round.state==='completed'?'check':'clock'} size={18}/>}
     <StatusText active={active} className="pilot-conversation-status-text">{count} / {round.members.length} 位干员已回应 · {connected?roundLabels[round.state]:'进度暂未更新，正在重连'}</StatusText>
    </div>
    {round.members.filter(member=>member.state!=='replied').map(member=>{
     const author:SpecialistReplyAuthor={kind:'specialist',name:member.roleName,roleId:member.roleId,workerId:member.id,sessionId:member.sessionId,channelSessionId:member.channelSessionId,conversationId:round.id,execution:member.execution,avatarId:member.avatarId};
     return <section className="ai-chat-message ai-role-assistant pilot-specialist-reply" key={member.id} data-role-id={member.roleId} data-state={member.state} title={member.reason}>
      <ReplyIdentity identity={{name:'Pilot',pilot:true}} author={author} authorMotion={connected&&member.state==='running'?'working':'still'} onSpecialist={onSpecialist}/>
      <div className="pilot-specialist-waiting"><Glyph name={['failed','timed_out','interrupted'].includes(member.state)?'alert':'clock'} size={16}/>
       <span>{member.roleName} · {connected?labels[member.state]:'等待重新连接'}{member.reason&&member.state==='failed'?`：${member.reason}`:''}</span>
      </div>
     </section>;
    })}
   </div>;
  })}
 </div>;
}
