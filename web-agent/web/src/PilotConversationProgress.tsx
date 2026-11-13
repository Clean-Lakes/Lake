import type {SpecialistConversation} from '../../shared/contracts';
import {Glyph} from './Icons';
import {LoadingWaves} from './LoadingWaves';
import {StatusText} from './StatusText';

const labels={queued:'尚未回应，等待唤醒',running:'尚未回应，正在回复',replied:'已回应',failed:'回应失败',timed_out:'未回应，等待超时',cancelled:'已停止',interrupted:'回应中断'} as const;
const roundLabels={queued:'正在召集',running:'等待干员回应',summarizing:'Pilot 正在汇总',completed:'Pilot 已汇总',cancelled:'召集已停止',interrupted:'召集已中断',failed:'Pilot 汇总未完成'} as const;

export function PilotConversationProgress({rounds,connected=true}:{rounds:SpecialistConversation[];connected?:boolean}){
 if(!rounds.length)return null;
 return <div className="pilot-dispatch-progress" role="status" aria-live="polite" aria-label="干员回应进展">
  {rounds.map(round=>{
   const count=round.members.filter(member=>member.state==='replied').length;
   const active=connected&&['queued','running','summarizing'].includes(round.state);
   return <div key={round.id} data-conversation-id={round.id} data-state={round.state}>
    <div className="pilot-dispatch-progress-row">
     {active?<LoadingWaves/>:<Glyph name={round.state==='completed'?'check':'clock'} size={18}/>}
     <StatusText active={active} className="pilot-dispatch-progress-text">{count} / {round.members.length} 位干员已回应 · {connected?roundLabels[round.state]:'进度暂未更新，正在重连'}</StatusText>
    </div>
    {round.members.filter(member=>member.state!=='replied').map(member=><div className="pilot-dispatch-progress-row" key={member.id} data-role-id={member.roleId} data-state={member.state} title={member.reason}>
     <Glyph name={['failed','timed_out','interrupted'].includes(member.state)?'alert':'clock'} size={16}/>
     <span className="pilot-dispatch-progress-text">{member.roleName} · {connected?labels[member.state]:'等待重新连接'}{member.reason&&member.state==='failed'?`：${member.reason}`:''}</span>
    </div>)}
   </div>;
  })}
 </div>;
}
