import type {SpecialistReplyAuthor} from '../../shared/contracts';
import {sessionInspectorId} from './SessionInspectorContext';
import {ReplyFooter} from './ReplyFooter';
import {specialistElapsed} from './replyDurationState';

/** The task record stays accessible independently of the changing public prose. */
export function SpecialistProcessLink({author,onInspect,active=false}:{author?:SpecialistReplyAuthor;onInspect?:(author:SpecialistReplyAuthor)=>void;active?:boolean}){
 const duration=specialistElapsed(author?.durationMs);
 if(!onInspect||!author?.taskId||!author.workerId||!author.roleId||!author.sessionId)return <ReplyFooter duration={duration}/>;
 return <ReplyFooter duration={duration} action={{
  label:`查看${author.name}的执行过程`,controls:sessionInspectorId,side:true,
  taskId:author.taskId,liveMotion:active,onClick:()=>onInspect(author)
 }}/>;
}
