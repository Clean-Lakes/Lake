import {useId} from 'react';
import {Glyph} from './Icons';

export function ChatGroupStart({members,disabled,inert,onMention}:{
 members:readonly {roleId:string;roleName:string;selected:boolean}[];
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
    <Glyph name="at" size={13}/><span>{member.roleName}</span>
   </button>)}
  </div>
 </section>;
}
