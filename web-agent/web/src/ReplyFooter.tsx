import {createContext} from 'react';
import {Glyph} from './Icons';
import {LiveTextMotionLabel} from './liveTextMotion';
import type {PilotProcessTarget} from './SessionInspectorContext';

type FooterMetadata={duration?:string; status?:string; notice?:string};
type FooterAction={
 text?:string; label?:string; controls:string; expanded?:boolean; side?:boolean; taskId?:string;
 liveMotion?:boolean; onClick:()=>void;
};

// Only the last visible report may carry its parent turn's elapsed time.
export const ReplyProcessContext=createContext<{pilot?:PilotProcessTarget; footer?:{reportId:string; metadata:FooterMetadata}}>({});

export function ReplyFooter({duration,status,notice,action}:FooterMetadata & {action?:FooterAction}) {
 const elapsed=duration?.replace(/(\d)(?=小时|分钟|秒)/g,'$1 ');
 const metadata=elapsed||status||notice;
 if(!metadata&&!action)return null;
 const specialistEntry=action?.liveMotion!==undefined;
 const label=action?.text??'查看执行过程';
 return <div className={specialistEntry?'reply-duration reply-process-text specialist-process-link':'reply-duration reply-process-text turn-status is-finished reply-footer'} aria-label={elapsed?'回答耗时':undefined}>
  {metadata&&<span className="turn-status-text">
   {elapsed&&<span className="turn-status-elapsed" title="本轮总耗时包含等待确认，不包含排队等待">{`${action?'本轮用时':'用时'} ${elapsed}`}</span>}
   {status&&<>{elapsed&&<span aria-hidden="true"> · </span>}{status}</>}
   {notice&&<span className="turn-execution-notice">{elapsed||status?' · ':''}{notice}</span>}
  </span>}
  {action&&<span className="reply-footer-action">
   {metadata&&<span aria-hidden="true" className="reply-footer-separator">·</span>}
   <button type="button" className="turn-duration-disclosure" data-placement={action.side?'side':'inline'} data-specialist-process={action.taskId}
    aria-label={action.label} aria-controls={action.controls} aria-expanded={action.expanded}
    onClick={event=>{event.currentTarget.focus({preventScroll:true});action.onClick();}}>
    {specialistEntry?<LiveTextMotionLabel active={!!action.liveMotion} glow>{label}</LiveTextMotionLabel>:label}
    <Glyph name="next" size={11} className="turn-duration-chevron"/>
   </button>
  </span>}
 </div>;
}
