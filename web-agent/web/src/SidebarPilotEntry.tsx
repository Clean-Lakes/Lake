import type {RefObject} from 'react';
import type {ConversationReadState} from '../../shared/contracts';
import {conversationAvatarMotion,pilotIdentity,type ConversationActivity} from './superAgentPresentation';
import {hasUnreadMessages} from './ConversationReadMarker';
import {Glyph} from './Icons';
import {greetRoleAvatar,SuperRoleAvatar} from './SuperRoleAvatar';

/** The built-in coordinator retains the original Pilot session and no delete menu. */
export function SidebarPilotEntry({selected,activity='idle',messageRead,disabled,onPilot,buttonRef}:{
 selected:boolean;activity?:ConversationActivity;messageRead?:ConversationReadState;disabled?:boolean;
 onPilot:()=>void;buttonRef?:RefObject<HTMLButtonElement|null>;
}) {
 const running=activity==='running',waiting=activity==='waiting';
 const unread=hasUnreadMessages(messageRead)&&!running&&!waiting;
 const status=running?'处理中':waiting?'待确认':unread?'有新消息未读':'';
 const label=`${pilotIdentity.name} · 打开对话 · 内置专员${status?` · ${status}`:''}`;
 return <button ref={buttonRef} type="button" className={`nav-row sidebar-pilot-entry${selected?' active':''}`} aria-label={label}
  aria-current={selected?'page':undefined} title={`打开 ${pilotIdentity.name} 对话`} disabled={disabled}
  onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')event.preventDefault();}}
  onClick={event=>{greetRoleAvatar(event.currentTarget);onPilot();}}>
  <SuperRoleAvatar {...pilotIdentity} motion={conversationAvatarMotion(activity)}/>
  <span className="nav-row-text">
   <span className="pilot-worker-name">
    <strong>{pilotIdentity.name}</strong>
    {status && <span className="pilot-worker-status">
     {running && <span className="pilot-worker-running" role="img" aria-label="处理中"><Glyph name="loader" size={12} className="activity-indicator"/></span>}
     {waiting && <span className="pilot-worker-confirmation">需确认</span>}
     {unread && <span className="pilot-worker-unread" role="img" aria-label="有新消息未读"/>}
    </span>}
    <Glyph name="next" size={14} className="pilot-entry-chevron"/>
   </span>
  </span>
 </button>;
}
