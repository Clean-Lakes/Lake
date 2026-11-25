import {useLayoutEffect,useRef,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import type {SpecialistChannelInfo} from '../../shared/contracts';
import {Glyph} from './Icons';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {useTerminalPopover} from './useTerminalPopover';

export function SpecialistRailPopover({id,channel,anchor,status,tone,showActions,canDelete,onClose,onMore,onTasks,onDelete}:{
 id:string;
 channel:SpecialistChannelInfo;
 anchor:RefObject<HTMLButtonElement|null>;
 status:string;
 tone?:'active'|'attention'|'unread';
 showActions:boolean;
 canDelete:boolean;
 onClose:()=>void;
 onMore:()=>void;
 onTasks?:()=>void;
 onDelete:()=>void;
}){
 const {trigger,menu}=useTerminalPopover(true,onClose);
 const header=useRef<HTMLElement>(null);
 const primary=useRef<HTMLButtonElement>(null);
 const more=useRef<HTMLButtonElement>(null);
 const dismiss=useRef(onClose);
 dismiss.current=onClose;

 useLayoutEffect(()=>{
  const button=anchor.current,popup=menu.current;
  if(!button||!popup)return;
  trigger.current=button;
  const rail=button.closest('.sidebar-specialist-roster');
  const place=()=>{
   const bounds=button.getBoundingClientRect(),visible=rail?.getBoundingClientRect();
   if(!button.isConnected||button.closest('[inert]')||(visible&&(bounds.bottom<=visible.top||bounds.top>=visible.bottom))){
    dismiss.current();
    return;
   }
   const gap=8,width=popup.offsetWidth,height=popup.offsetHeight;
   const right=Math.max(bounds.right+gap,(visible?.right??bounds.right)+6),left=bounds.left-gap-width;
   const x=right+width<=window.innerWidth-gap?right:left>=gap?left:window.innerWidth-width-gap;
   // Keep the identity aligned to its trigger when the management row opens.
   const identityCenter=header.current?header.current.offsetTop+header.current.offsetHeight/2:height/2;
   const y=bounds.top+bounds.height/2-identityCenter;
   popup.style.left=`${Math.max(gap,x)}px`;
   popup.style.top=`${Math.max(gap,Math.min(y,window.innerHeight-gap-height))}px`;
  };
  place();
  const first=more.current?.getAttribute('aria-expanded')==='true'?more.current:primary.current??more.current;
  first?.focus({preventScroll:true});
  const observer=new ResizeObserver(place);
  observer.observe(popup);
  observer.observe(button);
  rail?.addEventListener('scroll',place,{passive:true});
  window.addEventListener('resize',place);
  return ()=>{
   observer.disconnect();
   rail?.removeEventListener('scroll',place);
   window.removeEventListener('resize',place);
  };
 },[anchor,menu,trigger]);

 return createPortal(<div ref={menu} id={id} className="specialist-rail-popover"
  role="dialog" aria-labelledby={`${id}-name`} aria-describedby={`${id}-status`}>
  <header ref={header} className="specialist-rail-identity">
   <SuperRoleAvatar name={channel.roleName} roleId={channel.roleId} avatarId={channel.avatarId} motion="still" size={24}/>
   <span className="specialist-rail-copy">
    <strong id={`${id}-name`} title={channel.roleName}>{channel.roleName}</strong>
    <small id={`${id}-status`} data-tone={tone}>
     {tone&&<span className="specialist-rail-status-dot" aria-hidden="true"/>}{status}
    </small>
   </span>
  </header>
  {onTasks&&<button ref={primary} type="button" className="specialist-rail-task-action" aria-label="查看专员任务" onClick={onTasks}>
   <Glyph name="document" size={15}/><span>查看任务</span><Glyph name="next" size={13}/>
  </button>}
  <button ref={more} type="button" className="icon-button specialist-rail-more" aria-label="更多专员操作" title="更多操作"
   aria-expanded={showActions} aria-controls={`${id}-actions`} onClick={onMore}><Glyph name="more" size={16}/></button>
  <div id={`${id}-actions`} className="specialist-rail-management" hidden={!showActions}>
   <button type="button" className="specialist-rail-delete-action" disabled={!canDelete} onClick={onDelete}>
    <Glyph name="trash" size={15}/>删除专员
   </button>
  </div>
 </div>,document.body);
}
