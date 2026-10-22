import {useEffect,useId,useRef,useState,type ReactNode,type RefObject} from "react";
import type {Project,WorkSession,WorkspaceTag} from "../../shared/contracts";
import {api,readableError} from "./api";
import {Glyph,sessionIcons} from "./Icons";
import {NavigationMenu} from "./NavigationDelete";

const colors = [{id:"gray",label:"灰色"},{id:"green",label:"绿色"},{id:"blue",label:"蓝色"},{id:"purple",label:"紫色"},{id:"orange",label:"橙色"},{id:"red",label:"红色"}] as const;
function PresentationDialog({title,onClose,children,returnFocus}:{title:string;onClose:()=>void;children:ReactNode;returnFocus?:RefObject<HTMLElement|null>}) {
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>{dialog.current?.close();(returnFocus?.current??previous)?.focus();};},[returnFocus]);
 return <dialog ref={dialog} className="presentation-dialog" aria-label={title} onCancel={event=>{event.preventDefault();onClose();}}><div className="presentation-dialog-head"><h2>{title}</h2><button type="button" className="icon-button" aria-label={`关闭${title}`} onClick={onClose}><Glyph name="close"/></button></div>{children}</dialog>;
}
function ColorPicker({value,onChange}:{value:string;onChange:(value:WorkspaceTag["color"])=>void}) {
 return <div className="tag-colors" role="group" aria-label="标签颜色">{colors.map(color=><button key={color.id} type="button" className={`tag-color color-${color.id}`} aria-label={color.label} aria-pressed={value===color.id} onClick={()=>onChange(color.id)}>{value===color.id&&<Glyph name="check" size={13}/>}</button>)}</div>;
}
export function TagChip({tag}:{tag:WorkspaceTag}) {return <span className={`tag-chip color-${tag.color}`}><Glyph name="tag" size={12}/>{tag.name}</span>;}
export function SessionListTags({tags}:{tags:WorkspaceTag[]}) {
 if(!tags.length)return null;
 return <span className="session-list-tags" aria-label={`会话标签：${tags.map(tag=>tag.name).join("、")}`}>
  {tags.slice(0,2).map(tag=><span key={tag.id} className={`session-list-tag color-${tag.color}`} title={tag.name}>{tag.name}</span>)}
  {tags.length>2&&<span className="session-list-tags-more" title={tags.slice(2).map(tag=>tag.name).join("、")}>+{tags.length-2}</span>}
 </span>;
}

export function SessionStateBadge({session,label,status=session.status}:{session:WorkSession;label?:string;status?:WorkSession["status"]}) {
 const statuses={idle:"待命",investigating:"调查中",waiting_approval:"待确认",completed:"回复结束",failed:"需要关注"};
 return <span className={`session-state-badge state-${status}`}><span/>{label??statuses[status]}</span>;
}

const sessionViews=[{value:"conversation",label:"对话",icon:"chat"},{value:"plans",label:"计划",icon:"document"},{value:"activity",label:"执行记录",icon:"terminal"},{value:"evidence",label:"证据",icon:"document"}] as const;

export function SessionActions({session,tags,disabled,onSaved,onRefresh,onEdit,view,onView,hasViews,onDelete,className="icon-button",label="会话操作",menuPosition=null,onMenuChange}:{session:WorkSession;tags:WorkspaceTag[];disabled:boolean;onSaved:(session:WorkSession)=>void;onRefresh:()=>Promise<void>;onEdit:()=>void;view:string;onView:(view:string)=>void;hasViews:boolean;onDelete?:()=>void;className?:string;label?:string;menuPosition?:{x:number;y:number}|null;onMenuChange?:(position:{x:number;y:number}|null)=>void}) {
 const [editing,setEditing]=useState<"icons"|"tags"|null>(null);
 const [menu,setMenu]=useState<{x:number;y:number}|null>(null);
 const trigger=useRef<HTMLButtonElement>(null);
 const [busy,setBusy]=useState(false);const [error,setError]=useState("");
 const [name,setName]=useState("");const [color,setColor]=useState<WorkspaceTag["color"]>("purple");
 const chosen=session.tags??[];
 async function work(action:()=>Promise<void>) {setBusy(true);setError("");try{await action();}catch(e){setError(readableError(e));}finally{setBusy(false);}}
 async function save(icon:string,ids:string[]) {const updated=await api.saveSessionPresentation(session,icon,ids);onSaved(updated);await onRefresh();}
 const projectTags=tags.filter(tag=>tag.projectId===session.projectId);
 const menuViews=sessionViews.filter(item=>hasViews||item.value==='plans');
 const visibleMenu=onMenuChange?menuPosition:menu;
 const changeMenu=onMenuChange??setMenu;
 return <>
  <button type="button" ref={trigger} className={`${className} session-actions-trigger`} title="更多操作" aria-label={label} aria-haspopup="menu" aria-expanded={!!visibleMenu} disabled={disabled} onClick={()=>{if(visibleMenu){changeMenu(null);return;}const rect=trigger.current?.getBoundingClientRect();if(rect)changeMenu({x:rect.right-208,y:rect.bottom+6});}}><Glyph name="more" size={15}/></button>
  {visibleMenu&&<NavigationMenu title={session.title} className="session-actions-menu" anchor={trigger} width={208} x={visibleMenu.x} y={visibleMenu.y} onClose={()=>changeMenu(null)} actions={[
   ...menuViews.map(item=>({label:item.label,icon:item.icon,checked:view===item.value,run:()=>onView(item.value)})),
   {label:"重命名",icon:"edit",separatorBefore:true,disabled,run:onEdit},
   {label:"更换图标",icon:"image",disabled,run:()=>{setError("");setEditing("icons");}},
   {label:"编辑标签",icon:"tag",disabled,run:()=>{setError("");setEditing("tags");}},
   ...(onDelete?[{label:"删除会话",icon:"trash" as const,separatorBefore:true,disabled,danger:true,run:onDelete}]:[]),
  ]}/>}
  {editing&&<PresentationDialog returnFocus={trigger} title={editing==="icons"?"选择会话图标":"会话标签"} onClose={()=>{if(!busy)setEditing(null);}}>{editing==="icons"?<div className="session-icon-grid">{sessionIcons.map(icon=><button key={icon.id} type="button" aria-label={icon.label} aria-pressed={(session.icon??"chat")===icon.id} disabled={busy} onClick={()=>void work(async()=>{await save(icon.id,chosen.map(t=>t.id));setEditing(null);})}><Glyph name={icon.id} size={23}/><span>{icon.label}</span></button>)}</div>:<><div className="tag-picker-list">{projectTags.map(tag=><label key={tag.id}><input type="checkbox" checked={chosen.some(t=>t.id===tag.id)} disabled={busy||!chosen.some(t=>t.id===tag.id)&&chosen.length>=12} onChange={event=>void work(()=>save(session.icon??"chat",event.target.checked?[...chosen.map(t=>t.id),tag.id]:chosen.filter(t=>t.id!==tag.id).map(t=>t.id)))}/><TagChip tag={tag}/></label>)}{!projectTags.length&&<p className="presentation-note">创建标签，按主题整理项目会话。</p>}</div><form className="tag-create-form" onSubmit={event=>{event.preventDefault();void work(async()=>{const tag=await api.createTag(session.projectId,{name,color});setName("");await save(session.icon??"chat",[...chosen.map(t=>t.id),tag.id]);});}}><label>新标签<input value={name} maxLength={40} onChange={event=>setName(event.target.value)} placeholder="例如：数据库、巡检、故障排查" disabled={busy}/></label><ColorPicker value={color} onChange={setColor}/><button type="submit" className="button secondary" disabled={busy||!name.trim()||chosen.length>=12}><Glyph name="plus" size={14}/>创建并添加</button></form></>}{error&&<p className="form-error" role="alert">{error}</p>}</PresentationDialog>}
 </>;
}

export function TagNavigation({tags,sessions,selected,onSelect,onManage,onSession}:{tags:WorkspaceTag[];sessions:WorkSession[];selected:string|null;onSelect:(tag:string|null)=>void;onManage:()=>void;onSession:(session:string)=>void}) {
 const [expanded,setExpanded]=useState(false);
 const panelId=useId();
 useEffect(()=>{if(selected)setExpanded(true);},[selected]);
 return <section className="sidebar-tags" aria-label="标签导航"><div className="sidebar-tags-heading"><button type="button" className="sidebar-tags-toggle" aria-expanded={expanded} aria-controls={panelId} onClick={()=>setExpanded(value=>!value)}><Glyph name="tags" size={15}/><span>标签</span><small>{tags.length}</small><Glyph name="chevron" size={14} className={expanded ? "open" : ""}/></button>{expanded&&<button type="button" className="icon-button" aria-label="管理标签" title="管理标签" onClick={onManage}><Glyph name="filter" size={15}/></button>}</div><div id={panelId} hidden={!expanded}>{!tags.length?<button type="button" className="tag-empty-add" onClick={onManage}><Glyph name="plus" size={14}/>添加项目标签</button>:<div className="sidebar-tag-list">{tags.map(tag=>{const related=sessions.filter(session=>session.tags?.some(t=>t.id===tag.id));return <div key={tag.id}><button type="button" className={`tag-nav-row color-${tag.color} ${selected===tag.id?"active":""}`} aria-pressed={selected===tag.id} onClick={()=>onSelect(selected===tag.id?null:tag.id)}><span className="tag-dot"/><span>{tag.name}</span><small>{related.length}</small></button>{selected===tag.id&&<div className="tag-session-list">{related.map(session=><button type="button" key={session.id} onClick={()=>onSession(session.id)}><Glyph name={session.icon??"chat"} size={14}/><span>{session.title}</span></button>)}{!related.length&&<span className="presentation-note">暂无关联会话</span>}</div>}</div>;})}</div>}</div></section>;

}

export function TagManager({project,tags,onClose,onRefresh}:{project:Project;tags:WorkspaceTag[];onClose:()=>void;onRefresh:()=>Promise<void>}) {
 const [editing,setEditing]=useState<string|null>(null);const [name,setName]=useState("");const [color,setColor]=useState<WorkspaceTag["color"]>("purple");const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [confirm,setConfirm]=useState<string|null>(null);
 async function work(action:()=>Promise<unknown>) {setBusy(true);setError("");try{await action();await onRefresh();}catch(e){setError(readableError(e));}finally{setBusy(false);}}
 return <PresentationDialog title="管理项目标签" onClose={()=>{if(!busy)onClose();}}><p className="presentation-note">{project.name} · 标签可关联多个会话</p><div className="tag-manager-list">{tags.filter(t=>t.projectId===project.id).map(tag=><div key={tag.id}><TagChip tag={tag}/><button type="button" className="icon-button" aria-label={`编辑标签 ${tag.name}`} disabled={busy} onClick={()=>{setEditing(tag.id);setName(tag.name);setColor(tag.color);setConfirm(null);}}><Glyph name="edit" size={14}/></button><button type="button" className="icon-button" aria-label={`移除标签 ${tag.name}`} disabled={busy} onClick={()=>setConfirm(tag.id)}><Glyph name="trash" size={14}/></button></div>)}</div>{confirm&&<div className="tag-delete-confirm"><p>移除这个标签及其关联？会话内容会保留。</p><button type="button" disabled={busy} onClick={()=>setConfirm(null)}>取消</button><button type="button" disabled={busy} onClick={()=>void work(async()=>{await api.deleteTag(confirm);setConfirm(null);if(editing===confirm){setEditing(null);setName("");}})}>移除标签</button></div>}<form className="tag-create-form" onSubmit={event=>{event.preventDefault();void work(async()=>{if(editing)await api.updateTag(editing,{name,color});else await api.createTag(project.id,{name,color});setEditing(null);setName("");});}}><label>{editing?"修改标签":"新标签"}<input value={name} maxLength={40} onChange={event=>setName(event.target.value)} placeholder="标签名称" disabled={busy}/></label><ColorPicker value={color} onChange={setColor}/><div className="presentation-form-actions">{editing&&<button type="button" className="button secondary" disabled={busy} onClick={()=>{setEditing(null);setName("");}}>取消编辑</button>}<button type="submit" className="button primary" disabled={busy||!name.trim()}>{busy?"保存中…":editing?"保存标签":"创建标签"}</button></div></form>{error&&<p className="form-error" role="alert">{error}</p>}</PresentationDialog>;
}
