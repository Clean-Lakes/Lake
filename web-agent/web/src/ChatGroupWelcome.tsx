import {useId} from 'react';
import type {ChatGroupMember} from '../../shared/contracts';
import {Glyph} from './Icons';
import {SuperRoleAvatar} from './SuperRoleAvatar';

export function ChatGroupWelcome({title,members,canMention,onMention}:{
 title:string;
 members:readonly (ChatGroupMember&{duties?:string})[];
 canMention:boolean;
 onMention:(roleId:string)=>void;
}){
 const heading=useId();
 return <section className="timeline-empty group-welcome" aria-labelledby={heading}>
  <span className="group-welcome-mark" aria-hidden="true"><SuperRoleAvatar pilot size={34} motion="still"/></span>
  <h2 id={heading}>{title}</h2>
  <p>{members.length?'直接输入需求，或点名一位专员。':'发一条消息，开始群聊。'}</p>
  {members.length>0&&<ul className="group-welcome-members" aria-label="群组专员">{members.map(member=><li key={member.roleId}>
   <button type="button" className="group-welcome-member" aria-label={`提及${member.roleName}`}
    aria-describedby={member.duties?`${heading}-${member.roleId}`:undefined} disabled={!canMention} onClick={()=>onMention(member.roleId)}>
    <span className="group-welcome-member-avatar"><SuperRoleAvatar roleId={member.roleId} name={member.roleName} avatarId={member.avatarId} size={24} motion="still"/></span>
    <span className="group-welcome-member-label">
     <strong title={member.roleName}>{member.roleName}</strong>
     {member.duties&&<small id={`${heading}-${member.roleId}`} title={member.duties}>{member.duties}</small>}
    </span>
    <Glyph name="at" size={14}/>
   </button>
  </li>)}</ul>}
 </section>;
}
