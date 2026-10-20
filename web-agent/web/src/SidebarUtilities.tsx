import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {WorkSession,WorkspaceTag} from '../../shared/contracts';
import {Glyph} from './Icons';
import {TagNavigation} from './SessionPresentation';
import {DesktopUpdate} from './DesktopUpdate';
import './sidebarUtilities.css';

/** One stable footer entry; existing workspace actions keep their original flows. */
export function SidebarUtilities({tags,sessions,selectedTag,onSelectTag,onManageTags,onSession,onSettings,onTrash,onSchedules,booting,connected,modelConfigured}:{
 tags:WorkspaceTag[];sessions:WorkSession[];selectedTag:string|null;onSelectTag:(tag:string|null)=>void;
 onManageTags:()=>void;onSession:(id:string)=>void;onSettings:()=>void;onTrash:()=>void;onSchedules?:()=>void;
 booting:boolean;connected:boolean;modelConfigured:boolean;
}){
 const [open,setOpen]=useState(false);
 const [unreadUpdate,setUnreadUpdate]=useState(false);
 const [position,setPosition]=useState({left:8,bottom:8,width:240});
 const trigger=useRef<HTMLButtonElement>(null);
 const panel=useRef<HTMLDivElement>(null);
 const panelId=useId();
 const selected=tags.find(tag=>tag.id===selectedTag);
 function close(restoreFocus=false){setOpen(false);if(restoreFocus)trigger.current?.focus();}
 function act(action:()=>void){close(true);action();}
 useLayoutEffect(()=>{
  if(!open)return;
  const place=()=>{
   const rect=trigger.current?.getBoundingClientRect();if(!rect)return;
   const width=Math.min(240,window.innerWidth-16);
   const bottom=Math.max(8,window.innerHeight-rect.top+6);
   setPosition({left:Math.max(8,Math.min(rect.left,window.innerWidth-width-8)),bottom,width});
  };
  place();window.addEventListener('resize',place);
  return()=>window.removeEventListener('resize',place);
 },[open]);
 useEffect(()=>{
  if(!open)return;
  panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  const dismiss=(event:PointerEvent)=>{if(!panel.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))setOpen(false);};
  const keyboard=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);trigger.current?.focus();}};
  const focus=(event:FocusEvent)=>{if(!panel.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))setOpen(false);};
  document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',keyboard);document.addEventListener('focusin',focus);
  return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',keyboard);document.removeEventListener('focusin',focus);};
 },[open]);
 return <>
  <div className="sidebar-utilities"><button ref={trigger} type="button" className="workspace-utilities-trigger" aria-label={unreadUpdate?"工作区，有新版本":"工作区"} aria-haspopup="dialog" aria-expanded={open} aria-controls={open?panelId:undefined} onClick={()=>setOpen(value=>!value)}>
   <span className="workspace-utilities-glass" aria-hidden="true"/><span className="workspace-utilities-icon"><Glyph name="settings" size={16}/></span><span>工作区</span>{selected&&<small title={`标签筛选：${selected.name}`}>{selected.name}</small>}<span className="workspace-utilities-tail">{unreadUpdate&&<span className="workspace-utilities-update-dot" aria-hidden="true"/>}<Glyph name="chevron" size={13} className={open?'is-open':''}/></span>
  </button></div>
  <DesktopUpdate hideTrigger onUnreadChange={setUnreadUpdate}/>
  {open&&createPortal(<div ref={panel} id={panelId} role="dialog" aria-label="工作区操作" className="workspace-utilities-popover" style={{...position,maxHeight:`calc(100dvh - ${position.bottom+8}px)`}} onKeyDown={event=>{
   if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||event.target instanceof HTMLInputElement)return;
   const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(button=>button.getClientRects().length);
   const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
   event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();
  }}>
   <TagNavigation tags={tags} sessions={sessions} selected={selectedTag} onSelect={onSelectTag} onManage={()=>act(onManageTags)} onSession={id=>act(()=>onSession(id))}/>
   <div className="workspace-utilities-separator"/>
   {onSchedules&&<button type="button" className="workspace-utility-action" disabled={!connected} onClick={()=>act(onSchedules)}><Glyph name="clock" size={15}/><span>定时任务</span></button>}
   <button type="button" className="workspace-utility-action" disabled={booting} onClick={()=>act(onSettings)}><Glyph name="settings" size={15}/><span>设置</span>{!modelConfigured&&<small>待配置</small>}</button>
   <button type="button" className="workspace-utility-action" onClick={()=>act(()=>window.dispatchEvent(new Event('lake-open-updates')))}><Glyph name="refresh" size={15}/><span>检查更新</span>{unreadUpdate&&<small>新版本</small>}</button>
   <button type="button" className="workspace-utility-action" disabled={!connected} onClick={()=>act(onTrash)}><Glyph name="trash" size={15}/><span>已删除</span></button>
  </div>,document.body)}
 </>;
}
