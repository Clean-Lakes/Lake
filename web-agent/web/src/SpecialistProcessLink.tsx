import {useContext} from 'react';
import type {SpecialistReplyAuthor} from '../../shared/contracts';
import {sessionInspectorId,useSessionInspector,type InspectSpecialist} from './SessionInspectorContext';
import {ReplyFooter,ReplyProcessContext} from './ReplyFooter';
import {specialistElapsed} from './replyDurationState';

export function hasTaskProcess(author?:SpecialistReplyAuthor):author is SpecialistReplyAuthor & {taskId:string} {
 return !!(author?.taskId&&author.workerId&&author.roleId&&author.sessionId);
}

/** Keep the same task button as live prose becomes a settled report. */
export function SpecialistProcessLink({author,reportId,onInspect,active=false}:{author?:SpecialistReplyAuthor;reportId?:string;onInspect?:InspectSpecialist;active?:boolean}){
 const {pilot,footer}=useContext(ReplyProcessContext);
 const selection=useSessionInspector()?.selection;
 const duration=specialistElapsed(author?.durationMs);
 if(!onInspect||!hasTaskProcess(author))return <ReplyFooter duration={duration}/>;
 const metadata=footer&&footer.reportId===reportId?footer.metadata:undefined;
 const workerOpen=selection?.sessionId===author.sessionId&&selection.canonicalGoalId===author.taskId;
 const sources=selection?.replySources;
 const expanded=sources?!!pilot&&sources.pilot.turnId===pilot.turnId&&sources.pilot.sessionId===pilot.sessionId&&
  sources.specialist.taskId===author.taskId&&sources.specialist.sessionId===author.sessionId:workerOpen;
 return <ReplyFooter {...metadata} duration={duration} action={{
  text:metadata?'查看执行过程':'执行过程',label:metadata?`查看执行过程，${author.name}`:`查看${author.name}的执行过程`,controls:sessionInspectorId,side:true,
  taskId:author.taskId,expanded,liveMotion:metadata?undefined:active,onClick:()=>onInspect(author,pilot),
 }}/>;
}
