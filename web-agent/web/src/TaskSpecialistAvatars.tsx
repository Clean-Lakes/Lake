import {SuperRoleAvatar} from './SuperRoleAvatar';
import type {SpecialistTaskMember} from './specialistTaskListModel';

/** Shared task identities with an inline option for compact controls. */
export function TaskSpecialistAvatars({members,descriptionId,connected=true,inline=false}:{
 members:readonly SpecialistTaskMember[];
 descriptionId:string;
 connected?:boolean;
 inline?:boolean;
}){
 const shown=members.slice(0,3),remaining=members.length-shown.length;
 const description=`参与专员：${members.map(member=>member.name||'未命名专员').join('、')}`;
 return <>
  <span className="task-specialist-avatars" data-inline={inline||undefined} data-multiple={members.length>1||undefined} data-count={members.length} title={description} aria-hidden="true">
   {shown.map(member=><span className="task-specialist-avatar" key={member.key} data-role-id={member.roleId} data-report-avatar={member.key} title={member.name}><SuperRoleAvatar roleId={member.roleId} name={member.name} motion={connected&&member.moving?'working':'still'}/></span>)}
   {remaining>0&&<span className="task-specialist-overflow">+{remaining}</span>}
   {inline&&shown.length>2&&<span className="task-specialist-overflow is-narrow">+{members.length-2}</span>}
  </span>
  <span className="visually-hidden" id={descriptionId}>{description}</span>
 </>;
}
