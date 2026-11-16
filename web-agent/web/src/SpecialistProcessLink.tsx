import type {SpecialistReplyAuthor} from '../../shared/contracts';
import {Glyph} from './Icons';
import {sessionInspectorId} from './SessionInspectorContext';
import {LiveTextMotionLabel} from './liveTextMotion';

/** The task record stays accessible independently of the changing public prose. */
export function SpecialistProcessLink({author,onInspect,active=false}:{author?:SpecialistReplyAuthor;onInspect?:(author:SpecialistReplyAuthor)=>void;active?:boolean}){
 if(!onInspect||!author?.taskId||!author.workerId||!author.roleId||!author.sessionId)return null;
 return <div className="reply-duration reply-process-text specialist-process-link">
  <button type="button" className="turn-duration-disclosure" data-placement="side" data-specialist-process={author.taskId} aria-controls={sessionInspectorId} aria-label={`查看${author.name}的执行过程`} title="在右侧查看思考、公开进度和工具记录" onClick={()=>onInspect(author)}><LiveTextMotionLabel active={active} glow>执行过程</LiveTextMotionLabel><Glyph name="next" size={11} className="turn-duration-chevron"/></button>
 </div>;
}
