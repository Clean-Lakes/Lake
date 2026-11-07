import type {RefObject} from 'react';
import type {ConversationReadState} from '../../shared/contracts';
import type {ConversationActivity} from './superAgentPresentation';
import {hasUnreadMessages} from './ConversationReadMarker';
import {Glyph} from './Icons';
import {LakeLogo} from './LakeLogo';

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
  <LakeLogo size={32} decorative/>
  <span className="sidebar-pilot-copy">
   <span className="brand"><strong>Lake</strong></span>
   <span className="sidebar-pilot-destination">
    <span className="sidebar-pilot-caption">Pilot 主对话</span>
    <span className="sidebar-pilot-status" data-state={running?'running':waiting?'waiting':unread?'unread':undefined} aria-hidden="true">
     {running?<Glyph name="loader" size={13} className="activity-indicator"/>:waiting?<Glyph name="alert" size={13}/>:unread?<span className="pilot-worker-unread"/>:!selected&&!disabled?<Glyph name="next" size={11}/>:null}
    </span>
   </span>
  </span>
 </button>;
}
