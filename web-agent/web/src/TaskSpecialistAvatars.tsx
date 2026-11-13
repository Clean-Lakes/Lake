import {SuperRoleAvatar} from './SuperRoleAvatar';
import type {SpecialistTaskMember} from './specialistTaskListModel';

/** One identity slot today; a compact, borderless group for shared tasks. */
export function TaskSpecialistAvatars({members,descriptionId,connected=true}:{members:readonly SpecialistTaskMember[];descriptionId:string;connected?:boolean}){
 const shown=members.slice(0,3),remaining=members.length-shown.length;
 const description=`参与专员：${members.map(member=>member.name||'未命名专员').join('、')}`;
 return <>
  <span className="task-specialist-avatars" data-multiple={members.length>1||undefined} data-count={members.length} title={description} aria-hidden="true">
   {shown.map(member=><span className="task-specialist-avatar" key={member.key} data-role-id={member.roleId} title={member.name}><SuperRoleAvatar roleId={member.roleId} name={member.name} motion={connected&&member.moving?'working':'still'}/></span>)}
   {remaining>0&&<span className="task-specialist-overflow">+{remaining}</span>}
  </span>
  <span className="visually-hidden" id={descriptionId}>{description}</span>
 </>;
}
