import {useId} from 'react';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import type {LakeAvatarName} from './lakeAvatarCatalog';

export function ChatGroupStart({members,disabled,inert,onMention}:{
 members:readonly {roleId:string;roleName:string;avatarId?:LakeAvatarName;selected:boolean}[];
 disabled:boolean;
 inert:boolean;
 onMention:(roleId:string,origin:DOMRectReadOnly)=>void;
}){
 const heading=useId();
 return <section className="chat-group-start" aria-labelledby={heading} inert={inert}>
  <h2 id={heading}>发起协作</h2>
  <div className="chat-group-start-members" role="group" aria-label="点名专员">
   {members.map(member=><button type="button" key={member.roleId} className="chat-group-start-member"
    title={member.roleName} aria-label={member.selected?`定位${member.roleName}引用`:`提及${member.roleName}`}
    data-selected={member.selected||undefined} disabled={disabled}
    onClick={event=>onMention(member.roleId,event.currentTarget.getBoundingClientRect())}>
    <SuperRoleAvatar roleId={member.roleId} name={member.roleName} avatarId={member.avatarId} size={18} motion="still"/>
    <span className="chat-group-start-member-name">{member.roleName}</span>
   </button>)}
  </div>
 </section>;
}
