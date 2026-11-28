import {useEffect,useId,useRef,useState} from 'react';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import type {LakeAvatarName} from './lakeAvatarCatalog';

type StartMember={roleId:string;roleName:string;avatarId?:LakeAvatarName;selected:boolean};
const inlineMemberLimit=3;

export function ChatGroupStart({members,disabled,inert,onMention}:{
 members:readonly StartMember[];
 disabled:boolean;
 inert:boolean;
 onMention:(roleId:string,origin:DOMRectReadOnly)=>void;
}){
 const heading=useId();
 const moreId=useId();
 const root=useRef<HTMLElement>(null);
 const moreButton=useRef<HTMLButtonElement>(null);
 const [moreOpen,setMoreOpen]=useState(false);
 const remaining=members.slice(inlineMemberLimit);
 const expanded=moreOpen&&remaining.length>0&&!inert;

 useEffect(()=>{
  if(inert||!remaining.length)setMoreOpen(false);
 },[inert,remaining.length]);
 useEffect(()=>{
  if(!expanded)return;
  const outside=(event:PointerEvent)=>{
   if(event.target instanceof Node&&!root.current?.contains(event.target))setMoreOpen(false);
  };
  const escape=(event:KeyboardEvent)=>{
   if(event.key!=='Escape'||event.isComposing)return;
   setMoreOpen(false);
   if(event.target instanceof Node&&root.current?.contains(event.target)){
    event.preventDefault();
    moreButton.current?.focus({preventScroll:true});
   }
  };
  document.addEventListener('pointerdown',outside,true);
  document.addEventListener('keydown',escape);
  return ()=>{
   document.removeEventListener('pointerdown',outside,true);
   document.removeEventListener('keydown',escape);
  };
 },[expanded]);

 const memberButton=(member:StartMember)=><button type="button" key={member.roleId} className="chat-group-start-member"
  title={member.roleName} aria-label={member.selected?`定位${member.roleName}引用`:`提及${member.roleName}`}
  data-selected={member.selected||undefined} disabled={disabled}
  onClick={event=>onMention(member.roleId,event.currentTarget.getBoundingClientRect())}>
  <SuperRoleAvatar roleId={member.roleId} name={member.roleName} avatarId={member.avatarId} size={18} motion="still"/>
  <span className="chat-group-start-member-name">{member.roleName}</span>
 </button>;

 return <section ref={root} className="chat-group-start" aria-labelledby={heading} inert={inert}>
  <h2 id={heading}>发起协作</h2>
  <div className="chat-group-start-members" role="group" aria-label="点名专员">
   {members.slice(0,inlineMemberLimit).map(memberButton)}
   {remaining.length>0&&<button ref={moreButton} type="button" className="chat-group-start-member chat-group-start-more-toggle"
    aria-expanded={expanded} aria-controls={moreId}
    aria-label={expanded?'收起更多专员':`查看另外 ${remaining.length} 位专员`}
    onClick={()=>setMoreOpen(open=>!open)}>
    +{remaining.length}
    </button>}
  </div>
  {remaining.length>0&&<div id={moreId} className="chat-group-start-more-panel" role="group" aria-label="更多专员" hidden={!expanded}>
   {expanded&&remaining.map(memberButton)}
  </div>}
 </section>;
}
