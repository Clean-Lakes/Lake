import {Fragment,useEffect,useLayoutEffect,useRef,useState,type RefObject} from "react";
import {Glyph,type GlyphName} from "./Icons";
import {createPortal} from "react-dom";
import type {NavigationTrashItem} from "../../shared/contracts";
import {api,readableError} from "./api";

export type NavigationDeleteTarget = {kind:"project" | "resource" | "folder";id:string;projectId:string;name:string};
export function TrashIcon() {return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/></svg>;}
export function NavigationMenu({title,x,y,actions,onClose,className="",width,anchor}: {title:string;x:number;y:number;actions:{label:string;icon?:GlyphName;separatorBefore?:boolean;danger?:boolean;disabled?:boolean;checked?:boolean;run:()=>void}[];onClose:()=>void;className?:string;width?:number;anchor?:RefObject<HTMLButtonElement|null>}) {
 const menu=useRef<HTMLDivElement>(null);
 const [position,setPosition]=useState({left:x,top:y});
 useLayoutEffect(()=>{
  const place=()=>{
   const bounds=menu.current?.getBoundingClientRect();if(!bounds)return;
   const left=Math.max(8,Math.min(x,window.innerWidth-bounds.width-8));
   const top=Math.max(8,Math.min(y,window.innerHeight-bounds.height-8));
   setPosition(current=>current.left===left&&current.top===top?current:{left,top});
  };
  place();const observer=new ResizeObserver(place);if(menu.current)observer.observe(menu.current);
  window.addEventListener('resize',place);
  return()=>{observer.disconnect();window.removeEventListener('resize',place);};
 },[x,y,width]);
 const closeRef=useRef(onClose);closeRef.current=onClose;
 useEffect(() => {
  const previous=document.activeElement as HTMLElement|null;
  (menu.current?.querySelector<HTMLButtonElement>('button[aria-checked="true"]') ?? menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
  const dismiss=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node)&&!anchor?.current?.contains(event.target as Node))closeRef.current();};
  const key=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.preventDefault();closeRef.current();if(anchor?.current)anchor.current.focus();else previous?.focus();}};
  document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',key);
  return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',key);};
 },[]);
 return createPortal(<div ref={menu} role="menu" aria-label={`${title} 管理菜单`} className={`navigation-context-menu ${className}`} style={{width,...position}} onContextMenu={event=>event.preventDefault()} onPointerMove={event=>{const button=(event.target as Element).closest<HTMLButtonElement>('button');if(button&&!button.disabled&&document.activeElement!==button)button.focus({preventScroll:true});}} onKeyDown={event=>{if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;event.preventDefault();const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(event.key==="ArrowUp"?-1:1)+buttons.length)%buttons.length]?.focus();}}><small title={title}>{title}</small>{actions.map((action,index)=><Fragment key={action.label}>
  {action.separatorBefore&&index>0&&<div role="separator" className="navigation-menu-separator"/>}
  <button type="button" role={action.checked===undefined?"menuitem":"menuitemradio"} aria-checked={action.checked} disabled={action.disabled} className={action.danger?"danger-text":""} onClick={()=>{anchor?.current?.focus();onClose();action.run();}}>
   {action.icon?<Glyph name={action.icon} size={15}/>:action.danger?<TrashIcon/>:null}
   {!action.icon&&action.checked!==undefined&&<span className="menu-selection-mark">{action.checked&&<Glyph name="check" size={14}/>}</span>}
   <span className="menu-action-label">{action.label}</span>
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
 return <div className="modal-scrim"><section className="modal navigation-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="navigation-delete-title"><div className="modal-header"><span className="modal-icon danger-icon"><TrashIcon/></span><button className="icon-button" aria-label="关闭删除确认" disabled={busy} onClick={onClose}><Glyph name="close" size={14}/></button></div><h2 id="navigation-delete-title">删除{label}「{target.name}」？</h2><p className="modal-description">{target.kind==="folder"?"文件夹中的资源和子文件夹会移到上一级。可在“已删除”中恢复文件夹。":target.kind==="project"?"项目及其资源、会话会从导航中移除，配置和历史记录保留。可在“已删除”中恢复整个项目。":"将资源移到“已删除”，连接配置和会话记录保留，可随时恢复。"}</p>{error&&<p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button danger" disabled={busy} onClick={()=>void remove()}>{busy?"正在删除…":`删除${label}`}</button></div></section></div>;
}
export function NavigationTrash({onClose,onRestored}: {onClose:()=>void;onRestored:()=>Promise<void>}) {
 const [items,setItems]=useState<NavigationTrashItem[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(""),[error,setError]=useState("");
 useEffect(()=>{let active=true;void api.navigationTrash().then(result=>{if(active)setItems(result.items);}).catch(error=>{if(active)setError(readableError(error));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false};},[]);
 async function restore(item:NavigationTrashItem) {
  if(busy)return;setBusy(item.id);setError("");
  try {const result=await api.restoreNavigation(item.kind,item.id);setItems(result.items);await onRestored();}catch(error){setError(readableError(error));}finally{setBusy("");}
 }
 return <div className="modal-scrim"><section className="modal navigation-trash-dialog" role="dialog" aria-modal="true" aria-labelledby="navigation-trash-title"><div className="modal-header"><h2 id="navigation-trash-title">已删除</h2><button className="icon-button" aria-label="关闭已删除列表" disabled={!!busy} onClick={onClose}><Glyph name="close" size={14}/></button></div><p className="modal-description">恢复项目、资源和文件夹。所属项目已删除时，请先恢复项目。</p>{error&&<p className="form-error" role="alert">{error}</p>}{loading?<p className="settings-note">正在加载…</p>:!items.length?<p className="settings-note">暂无已删除内容</p>:<ul className="navigation-trash-list">{items.map(item=><li key={`${item.kind}:${item.id}`}><div><strong>{item.name}</strong><small>{item.kind==="folder"?"文件夹":item.kind==="project"?"项目":"资源"}{item.kind!=="project"?` · ${item.projectName}`:""}</small></div><button className="button secondary" aria-label={`恢复 ${item.name}`} disabled={!!busy || item.kind!=="project"&&items.some(parent=>parent.kind==="project"&&parent.id===item.projectId)} onClick={()=>void restore(item)}>{busy===item.id?"恢复中…":"恢复"}</button></li>)}</ul>}</section></div>;
}
