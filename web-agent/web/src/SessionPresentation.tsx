import {useEffect,useRef,useState,type ReactNode,type RefObject} from "react";
import type {WorkSession} from "../../shared/contracts";
import {api,readableError} from "./api";
import {Glyph,sessionIcons} from "./Icons";
import {NavigationMenu} from "./NavigationDelete";
import {sessionBadgeState} from './sessionBadgeState';

function PresentationDialog({title,onClose,children,returnFocus}:{title:string;onClose:()=>void;children:ReactNode;returnFocus?:RefObject<HTMLElement|null>}) {
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>{dialog.current?.close();(returnFocus?.current??previous)?.focus();};},[returnFocus]);
 return <dialog ref={dialog} className="presentation-dialog" aria-label={title} onCancel={event=>{event.preventDefault();onClose();}}><div className="presentation-dialog-head"><h2>{title}</h2><button type="button" className="icon-button" aria-label={`关闭${title}`} onClick={onClose}><Glyph name="close"/></button></div>{children}</dialog>;
}
export function SessionStateBadge({session,label,idleLabel,activeLabel,status=session.status,iconOnly=false}:{session:WorkSession;label?:string;idleLabel?:string;activeLabel?:string;status?:WorkSession["status"];iconOnly?:boolean}) {
 const statuses={idle:"待命",investigating:"调查中",waiting_approval:"待确认",completed:"回复结束",failed:"需要关注"};
 const full=label??statuses[status];
 const badge=sessionBadgeState(status,label);
 const standalone=badge.state==='working'||badge.state==='idle'||badge.state==='attention';
 const pilotIcon=badge.state==='approval'?'shieldOutline':badge.state==='attention'?'circleAlert':badge.icon;
 return <span className={`session-state-badge state-${status}`} data-badge-state={badge.state} data-tone={badge.tone}
  data-icon-only={iconOnly||undefined} role={iconOnly?'img':undefined} title={full} aria-label={full}>
  {iconOnly?<span className="session-state-icon pilot-status-mark" data-ring={!standalone||undefined} aria-hidden="true"><Glyph name={pilotIcon} size={standalone?16:10}/></span>:
   <><Glyph name={badge.icon} size={13} className="session-state-icon"/><span className="session-state-label">{badge.state==='idle'&&idleLabel?idleLabel:badge.state==='working'&&activeLabel?activeLabel:badge.label}</span></>}
 </span>;
}

const sessionViews=[{value:"conversation",label:"对话",icon:"chat"},{value:"plans",label:"计划",icon:"document"},{value:"activity",label:"执行记录",icon:"terminal"},{value:"evidence",label:"证据",icon:"document"}] as const;

export function SessionActions({session,disabled,onSaved,onRefresh,onEdit,view,onView,hasViews,onDelete,onPin,className="icon-button",label="会话操作",menuPosition=null,onMenuChange}:{session:WorkSession;disabled:boolean;onSaved:(session:WorkSession)=>void;onRefresh:()=>Promise<void>;onEdit:()=>void;view:string;onView:(view:string)=>void;hasViews:boolean;onDelete?:()=>void;onPin?:()=>void;className?:string;label?:string;menuPosition?:{x:number;y:number}|null;onMenuChange?:(position:{x:number;y:number}|null)=>void}) {
 const [editing,setEditing]=useState(false);
 const [menu,setMenu]=useState<{x:number;y:number}|null>(null);
 const trigger=useRef<HTMLButtonElement>(null);
 const [busy,setBusy]=useState(false);const [error,setError]=useState("");
 async function saveIcon(icon:string) {
  setBusy(true);
  setError("");
  try {
   onSaved(await api.saveSessionPresentation(session,icon));
   await onRefresh();
   setEditing(false);
  } catch (error) {
   setError(readableError(error));
  } finally {
   setBusy(false);
  }
 }
 const menuViews=sessionViews.filter(item=>hasViews||item.value==='plans');
 const visibleMenu=onMenuChange?menuPosition:menu;
 const changeMenu=onMenuChange??setMenu;
 return <>
  <button type="button" ref={trigger} className={`${className} session-actions-trigger`} title="更多操作" aria-label={label} aria-haspopup="menu" aria-expanded={!!visibleMenu} disabled={disabled} onClick={()=>{if(visibleMenu){changeMenu(null);return;}const rect=trigger.current?.getBoundingClientRect();if(rect)changeMenu({x:rect.right-208,y:rect.bottom+6});}}><Glyph name="more" size={15}/></button>
  {visibleMenu&&<NavigationMenu title={session.title} className="session-actions-menu" anchor={trigger} width={208} x={visibleMenu.x} y={visibleMenu.y} onClose={()=>changeMenu(null)} actions={[
   ...menuViews.map(item=>({label:item.label,icon:item.icon,checked:view===item.value,run:()=>onView(item.value)})),
   ...(onPin?[{label:session.pinned?"取消置顶":"置顶会话",icon:"pin" as const,separatorBefore:true,disabled,run:onPin}]:[]),
   {label:"重命名",icon:"edit",separatorBefore:true,disabled,run:onEdit},
   {label:"更换图标",icon:"image",disabled,run:()=>{setError("");setEditing(true);}},
   ...(onDelete?[{label:"删除会话",icon:"trash" as const,separatorBefore:true,disabled,danger:true,run:onDelete}]:[]),
  ]}/>}
  {editing&&<PresentationDialog returnFocus={trigger} title="选择会话图标" onClose={()=>{if(!busy)setEditing(false);}}>
   <div className="session-icon-grid">{sessionIcons.map(icon=>
    <button key={icon.id} type="button" aria-label={icon.label} aria-pressed={(session.icon??"chat")===icon.id} disabled={busy} onClick={()=>void saveIcon(icon.id)}>
     <Glyph name={icon.id} size={23}/><span>{icon.label}</span>
    </button>)}</div>
   {error&&<p className="form-error" role="alert">{error}</p>}
  </PresentationDialog>}
 </>;
}
