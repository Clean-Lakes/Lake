import type {RefObject} from 'react';
import type {ConversationReadState} from '../../shared/contracts';
import type {ConversationActivity} from './superAgentPresentation';
import {hasUnreadMessages} from './ConversationReadMarker';
import {Glyph} from './Icons';

/** Brand and navigation share one destination; search remains a sibling button. */
export function SidebarPilotEntry({selected,activity='idle',messageRead,disabled,onPilot,buttonRef}:{
 selected:boolean;activity?:ConversationActivity;messageRead?:ConversationReadState;disabled?:boolean;
 onPilot:()=>void;buttonRef?:RefObject<HTMLButtonElement|null>;
}) {
 const running=activity==='running',waiting=activity==='waiting';
 const unread=hasUnreadMessages(messageRead)&&!running&&!waiting;
 const status=running?'处理中':waiting?'待确认':unread?'有新消息未读':'';
 const label=`Lake · Pilot 主对话${status?` · ${status}`:''}`;
 return <button ref={buttonRef} type="button" className="sidebar-pilot-entry" aria-label={label}
  aria-current={selected?'page':undefined} title={`${label} · 持续沟通，自动安排工作`} disabled={disabled} onClick={onPilot}>
  <span className="brand">
   <strong>Lake</strong>
   <span className="sidebar-pilot-slash" aria-hidden="true"/>
   <span className="sidebar-pilot-name">Pilot</span>
  </span>
  {status && <span className="sidebar-pilot-status" aria-hidden="true">
   {running && <Glyph name="loader" size={13} className="activity-indicator"/>}
   {waiting && <Glyph name="alert" size={13} className="sidebar-pilot-waiting"/>}
   {unread && <span className="pilot-worker-unread"/>}
  </span>}
 </button>;
}
