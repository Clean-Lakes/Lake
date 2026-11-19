import {createContext} from 'react';
import {Glyph} from './Icons';
import {LiveTextMotionLabel} from './liveTextMotion';
import type {PilotProcessTarget} from './SessionInspectorContext';

type FooterAction={
 text?:string; label?:string; controls:string; expanded?:boolean; side?:boolean; taskId?:string;
 liveMotion?:boolean; onClick:()=>void;
};

export const ReplyProcessContext=createContext<{pilot?:PilotProcessTarget;footer?:{reportId:string;status?:string}}>({});

export function ReplyFooter({duration,status,action}:{duration?:string;status?:string;action?:FooterAction}) {
 const elapsed=duration?.replace(/(\d)(?=小时|分钟|秒)/g,'$1 ');
 if(!action&&!elapsed&&!status)return null;
 const specialist=!!action?.taskId;
 const label=action?.text??'执行过程';
 return <div className={specialist?'reply-duration reply-process-text specialist-process-link':'reply-duration reply-process-text turn-status is-finished reply-footer'} aria-label={elapsed?'回答耗时':undefined}>
  {action&&<button type="button" className="turn-duration-disclosure" data-placement={action.side?'side':'inline'} data-specialist-process={action.taskId}
    aria-label={action.label??`查看${label}`} aria-controls={action.controls} aria-expanded={action.expanded}
    onClick={event=>{event.currentTarget.focus({preventScroll:true});action.onClick();}}>
   {specialist?<LiveTextMotionLabel active={!!action.liveMotion} glow>{label}</LiveTextMotionLabel>:label}
   <Glyph name="next" size={11} className="turn-duration-chevron"/>
  </button>}
  {elapsed&&<span className="turn-status-elapsed" title="本次执行用时">{action?elapsed:`用时 ${elapsed}`}</span>}
  {status&&<span>{status}</span>}
 </div>;
}
