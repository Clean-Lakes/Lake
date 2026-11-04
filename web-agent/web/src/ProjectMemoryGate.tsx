import {useEffect,useRef,type ReactNode} from "react";

// Only the current format may mount the editable view and its API effects.
export function ProjectMemoryGate({version,error="",onClose,children}:{version:number|null;error?:string;onClose:()=>void;children:ReactNode}) {
 const blocked=version!==1||!!error;
 const closeButton=useRef<HTMLButtonElement>(null);
 useEffect(()=>{
  if(!blocked)return;
  const previous=document.activeElement as HTMLElement|null;
  closeButton.current?.focus();
  return()=>{if(previous?.isConnected)previous.focus()};
 },[blocked]);
 if(!blocked)return children;
 const message=error||(version===null?"正在读取项目记忆…":version===2?"旧版运维记忆管理已停用，历史记录仍保留。":"暂不支持此记忆格式，请使用兼容版本。");
 return <div className="modal-scrim" onMouseDown={event=>{if(event.target===event.currentTarget){event.preventDefault();onClose()}}} onKeyDown={event=>{
  if(event.key==="Escape"){event.preventDefault();event.stopPropagation();onClose()}
  if(event.key==="Tab"){event.preventDefault();closeButton.current?.focus()}
 }}><section className="modal project-memory-modal" role="dialog" aria-modal="true" aria-label="项目记忆"><h2>项目记忆</h2><p role="status">{message}</p><button ref={closeButton} type="button" className="button secondary" onClick={onClose}>关闭</button></section></div>;
}
