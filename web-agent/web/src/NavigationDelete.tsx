import {Fragment,useEffect,useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from "react";
import {Glyph,type GlyphName} from "./Icons";
import {createPortal} from "react-dom";
import {api,readableError} from "./api";

export type NavigationDeleteTarget = {kind:"project" | "resource" | "folder";id:string;projectId:string;name:string};
export function TrashIcon() {return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/></svg>;}
type NavigationMenuPosition =
 | {x:number;y:number;anchor?:RefObject<HTMLButtonElement|null>;placement?:undefined}
 | {x?:never;y?:never;anchor:RefObject<HTMLButtonElement|null>;placement:'above'|'beside'};

export function NavigationMenu({id,title,headerIcon,x=0,y=0,actions,onClose,className="",width,anchor,placement}: {id?:string;title:string;headerIcon?:ReactNode;actions:{label:string;description?:string;icon?:GlyphName;trailingIcon?:GlyphName;separatorBefore?:boolean;danger?:boolean;disabled?:boolean;current?:boolean;checked?:boolean;selectionType?:'radio'|'checkbox';run:()=>void}[];onClose:()=>void;className?:string;width?:number} & NavigationMenuPosition) {
 const menu=useRef<HTMLDivElement>(null);
 const closeRef=useRef(onClose);closeRef.current=onClose;
 const [position,setPosition]=useState({left:x,top:y});
 useLayoutEffect(()=>{
  const place=()=>{
   const node=menu.current;if(!node)return;
   const button=placement?anchor?.current:null;
   if(placement&&(!button?.getClientRects().length||button.closest('[inert]'))){closeRef.current();return;}
   const bounds=button?.getBoundingClientRect();
   const menuWidth=node.offsetWidth;
   const height=node.offsetHeight;
   let preferredLeft=bounds?.left??x;
   if(bounds&&placement==='beside'){
    preferredLeft=bounds.right+6;
    if(preferredLeft+menuWidth>window.innerWidth-8&&bounds.left-menuWidth-6>=8)preferredLeft=bounds.left-menuWidth-6;
   }
   const left=Math.max(8,Math.min(preferredLeft,window.innerWidth-menuWidth-8));
   const preferredTop=bounds?bounds.top-(placement==='above'?height+8:0):y;
   const top=Math.max(8,Math.min(preferredTop,window.innerHeight-height-8));
   setPosition(current=>current.left===left&&current.top===top?current:{left,top});
  };
  place();const observer=new ResizeObserver(place);if(menu.current)observer.observe(menu.current);
  window.addEventListener('resize',place);
  return()=>{observer.disconnect();window.removeEventListener('resize',place);};
 },[x,y,width,anchor,placement]);
 useEffect(() => {
  const previous=document.activeElement as HTMLElement|null;
  (menu.current?.querySelector<HTMLButtonElement>('button[aria-checked="true"]') ?? menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus({preventScroll:true});
  const dismiss=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node)&&!anchor?.current?.contains(event.target as Node))closeRef.current();};
  const key=(event:KeyboardEvent)=>{
   const escape=event.key==='Escape';
   if(!escape&&!(placement&&event.key==='Tab'&&menu.current?.contains(event.target as Node)))return;
   if(escape)event.preventDefault();
   (anchor?.current??previous)?.focus({preventScroll:true});
   closeRef.current();
  };
  document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',key);
  return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',key);};
 },[]);
 return createPortal(<div ref={menu} id={id} role="menu" aria-label={`${title} 管理菜单`} className={`navigation-context-menu ${className}`} style={{width,...position}} onContextMenu={event=>event.preventDefault()} onPointerMove={event=>{const button=(event.target as Element).closest<HTMLButtonElement>('button');if(button&&!button.disabled&&document.activeElement!==button)button.focus({preventScroll:true});}} onKeyDown={event=>{if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;event.preventDefault();const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(event.key==="ArrowUp"?-1:1)+buttons.length)%buttons.length]?.focus();}}>
  <small className="navigation-menu-heading" title={title}>{headerIcon&&<span aria-hidden="true">{headerIcon}</span>}<span className="navigation-menu-title">{title}</span></small>
  {actions.map((action,index)=><Fragment key={action.label}>
  {action.separatorBefore&&index>0&&<div role="separator" className="navigation-menu-separator"/>}
  <button type="button" role={action.checked===undefined?"menuitem":action.selectionType==='checkbox'?"menuitemcheckbox":"menuitemradio"} aria-current={action.current?'page':undefined} aria-checked={action.checked} disabled={action.disabled} className={action.danger?"danger-text":""} onClick={()=>{anchor?.current?.focus({preventScroll:true});onClose();action.run();}}>
   {action.icon?<Glyph name={action.icon} size={15}/>:action.danger?<TrashIcon/>:null}
   {!action.icon&&action.checked!==undefined&&<span className="menu-selection-mark">{action.checked&&<Glyph name="check" size={14}/>}</span>}
   <span className="menu-action-label">{action.label}{action.description&&<small className="menu-action-description">{action.description}</small>}</span>
   {action.trailingIcon&&<Glyph name={action.trailingIcon} className="navigation-menu-trailing" size={13}/>}
   {action.icon&&action.checked!==undefined&&<span className="menu-selection-mark menu-selection-end">{action.checked&&<Glyph name="check" size={14}/>}</span>}
  </button>
 </Fragment>)}</div>,document.body);
}
export function NavigationDelete({target,onClose,onDeleted}: {target:NavigationDeleteTarget;onClose:()=>void;onDeleted:()=>Promise<void>}) {
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 const label=target.kind==="folder"?"文件夹":target.kind==="project"?"项目":"资源";
 async function remove() {
  if(busy)return;setBusy(true);setError("");
  try {
   if(target.kind==="folder")await api.editResourceTree(target.projectId,{operation:"delete",nodeId:target.id});
   else await api.deleteNavigation(target.kind,target.id);
   await onDeleted();onClose();
  }catch(error){setError(readableError(error));}finally{setBusy(false);}
 }
 return <div className="modal-scrim"><section className="modal workbench-dialog navigation-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="navigation-delete-title">
  <header className="workbench-dialog-header">
   <h2 id="navigation-delete-title">删除{label}「{target.name}」？</h2>
   <button type="button" className="icon-button" aria-label="关闭删除确认" disabled={busy} onClick={onClose}><Glyph name="close" size={16}/></button>
  </header>
  <div className="workbench-dialog-body">
   <p className="modal-description">{target.kind==="folder"?"文件夹将从导航中移除，其中的资源和子文件夹会移到上一级。":target.kind==="project"?"项目及其资源、会话将从导航中移除。系统保留配置和历史记录。":"资源将从导航中移除。系统保留连接配置和会话记录。"}</p>
   {error&&<p className="form-error" role="alert">{error}</p>}
  </div>
  <footer className="workbench-dialog-footer">
   <button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button>
   <button type="button" className="button danger" disabled={busy} onClick={()=>void remove()}>{busy?"正在删除…":`删除${label}`}</button>
  </footer>
 </section></div>;
}
