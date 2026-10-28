import {useEffect,useId,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {Project,WorkSession,WorkspaceTag} from '../../shared/contracts';
import {Glyph} from './Icons';
import {TagNavigation} from './SessionPresentation';
import {DesktopUpdate} from './DesktopUpdate';
import {readableError} from './api';
import {workspaceMenuParent,workspaceMenuPosition,type WorkspaceMenuView} from './workspaceMenu';
import './sidebarUtilities.css';

/** One anchored surface, with local pages for switching and managing projects. */
export function SidebarUtilities({projects,projectId,projectSelection,onSelectProject,onCreateProject,onDeleteProject,onToggleBulk,bulkMode,tags,sessions,selectedTag,onSelectTag,onManageTags,onSession,onSettings,onTrash,onSchedules,booting,connected,modelConfigured}:{
 projects:Project[];projectId?:string;projectSelection?:ReactNode;onSelectProject:(id:string)=>void;
 onCreateProject:(name:string)=>Promise<void>;onDeleteProject:(project:Project)=>Promise<void>;onToggleBulk:()=>void;bulkMode:boolean;
 tags:WorkspaceTag[];sessions:WorkSession[];selectedTag:string|null;onSelectTag:(tag:string|null)=>void;
 onManageTags:()=>void;onSession:(id:string)=>void;onSettings:()=>void;onTrash:()=>void;onSchedules?:()=>void;
 booting:boolean;connected:boolean;modelConfigured:boolean;
}){
 const [open,setOpen]=useState(false),[view,setView]=useState<WorkspaceMenuView>('home');
 const [unreadUpdate,setUnreadUpdate]=useState(false),[draft,setDraft]=useState(''),[error,setError]=useState('');
 const [busy,setBusy]=useState<'create'|'delete'|null>(null),operation=useRef<'create'|'delete'|null>(null);
 const [managedProject,setManagedProject]=useState<Project|null>(null);
 const [position,setPosition]=useState({left:8,bottom:8,width:240,height:432});
 const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
 const homeContent=useRef<HTMLDivElement>(null),contentHeight=useRef(432);
 const panelId=useId(),nameId=useId(),errorId=useId();
 const selected=tags.find(tag=>tag.id===selectedTag),currentProject=projects.find(project=>project.id===projectId);
 function close(restoreFocus=false){if(operation.current)return;setOpen(false);if(restoreFocus)trigger.current?.focus({preventScroll:true});}
 function act(action:()=>void){if(operation.current)return;close(true);action();}
 function page(next:WorkspaceMenuView){if(operation.current)return;setError('');setView(next);}
 useEffect(()=>{if(!operation.current){setOpen(false);setView('home');setError('');}},[projectId]);
 useLayoutEffect(()=>{
  if(!open)return;
  const place=()=>{
   const anchor=trigger.current?.getBoundingClientRect();if(!anchor)return;
   const naturalHeight=homeContent.current?.offsetHeight;
   // Fit the home page once, then retain that height while visiting subpages.
   if(naturalHeight)contentHeight.current=naturalHeight+14;
   setPosition(workspaceMenuPosition(anchor,{width:innerWidth,height:innerHeight},contentHeight.current));
  };
  const observer=new ResizeObserver(place);if(trigger.current)observer.observe(trigger.current);if(homeContent.current)observer.observe(homeContent.current);
  place();window.addEventListener('resize',place);
  return()=>{observer.disconnect();window.removeEventListener('resize',place);};
 },[open]);
 useLayoutEffect(()=>{
  if(!open||busy)return;
  const active=panel.current?.querySelector<HTMLElement>(`[data-workspace-page="${view}"]`);
  const target=view==='create'?active?.querySelector<HTMLInputElement>('input'):view==='delete'?active?.querySelector<HTMLButtonElement>('[data-delete-cancel]'):view==='projects'?active?.querySelector<HTMLButtonElement>('[aria-checked="true"]'):undefined;
  (target??active?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus({preventScroll:true});
 },[open,view,busy]);
 useEffect(()=>{
  if(!open)return;
  const dismiss=(event:PointerEvent)=>{if(!panel.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))close();};
  const focus=(event:FocusEvent)=>{if(!panel.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))close();};
  document.addEventListener('pointerdown',dismiss);document.addEventListener('focusin',focus);
  return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('focusin',focus);};
 },[open]);
 async function work(kind:'create'|'delete'){
  if(operation.current||!connected||kind==='create'&&!draft.trim()||kind==='delete'&&!managedProject)return;
  operation.current=kind;setBusy(kind);setError('');
  try{
   if(kind==='create')await onCreateProject(draft.trim());else await onDeleteProject(managedProject!);
   operation.current=null;setBusy(null);close(true);
  }catch(error){setError(readableError(error));}
  finally{operation.current=null;setBusy(null);}
 }
 const back=(title:string)=><header className="workspace-menu-heading"><button type="button" className="icon-button workspace-menu-back" aria-label="返回" disabled={!!busy} onClick={()=>page(workspaceMenuParent(view))}><Glyph name="next" size={16}/></button><strong>{title}</strong></header>;
 const errorMessage=error&&<p id={errorId} className="workspace-menu-error" role="alert">{error}</p>;
 return <>
  <div className="sidebar-utilities"><button ref={trigger} type="button" className="workspace-utilities-trigger" aria-label={unreadUpdate?'工作区，有新版本':'工作区'} aria-haspopup="dialog" aria-expanded={open} aria-controls={open?panelId:undefined} onKeyDown={event=>{if(open&&event.key==='Escape'){event.preventDefault();close(true);}}} onClick={()=>{if(open)close();else{setView('home');setError('');setOpen(true);}}}>
   <span className="workspace-utilities-glass" aria-hidden="true"/><span className="workspace-utilities-icon"><Glyph name="settings" size={16}/></span><span>工作区</span>{selected&&<small title={`标签筛选：${selected.name}`}>{selected.name}</small>}<span className="workspace-utilities-tail">{unreadUpdate&&<span className="workspace-utilities-update-dot" aria-hidden="true"/>}<Glyph name="chevron" size={13} className={open?'is-open':''}/></span>
  </button></div>
  <DesktopUpdate hideTrigger onUnreadChange={setUnreadUpdate}/>
  {open&&createPortal(<div ref={panel} id={panelId} role="dialog" aria-label="工作区操作" aria-busy={!!busy} className="workspace-utilities-popover" style={position} onKeyDown={event=>{
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(view==='home')close(true);else page(workspaceMenuParent(view));return;}
   if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||(event.target as HTMLElement).closest('input,textarea,[contenteditable="true"]'))return;
   const scope=(event.target as HTMLElement).closest('.workspace-project-options')??event.currentTarget;
   const buttons=[...scope.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter(button=>button.getClientRects().length);
   const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
   event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();
  }}>
   <section className="workspace-menu-page" data-workspace-page="home" hidden={view!=='home'} inert={view!=='home'}>
    <div className="workspace-menu-scroll"><div ref={homeContent}>
     <div className="workspace-menu-label">当前项目</div>
     <div className="workspace-current-project">{projectSelection}<button type="button" className="workspace-utility-action workspace-project-entry" aria-label={`切换项目：${currentProject?.name??'选择项目'}`} onClick={()=>page('projects')}><span title={currentProject?.name}>{currentProject?.name??'选择项目'}</span><Glyph name="next" size={14}/></button></div>
     <button type="button" className="workspace-utility-action" disabled={!connected||!currentProject} onClick={()=>{setManagedProject(currentProject!);page('manage');}}><Glyph name="filter" size={15}/><span>管理当前项目</span></button>
     <div className="workspace-utilities-separator"/>
     <TagNavigation defaultExpanded tags={tags} sessions={sessions} selected={selectedTag} onSelect={onSelectTag} onManage={()=>act(onManageTags)} onSession={id=>act(()=>onSession(id))}/>
     <div className="workspace-utilities-separator"/>
     {onSchedules&&<button type="button" className="workspace-utility-action" disabled={!connected} onClick={()=>act(onSchedules)}><Glyph name="clock" size={15}/><span>定时任务</span></button>}
     <button type="button" className="workspace-utility-action" disabled={booting} onClick={()=>act(onSettings)}><Glyph name="settings" size={15}/><span>设置</span>{!modelConfigured&&<small>待配置</small>}</button>
     <button type="button" className="workspace-utility-action" onClick={()=>act(()=>window.dispatchEvent(new Event('lake-open-updates')))}><Glyph name="refresh" size={15}/><span>检查更新</span>{unreadUpdate&&<small>新版本</small>}</button>
     <button type="button" className="workspace-utility-action" disabled={!connected} onClick={()=>act(onTrash)}><Glyph name="trash" size={15}/><span>已删除</span></button>
    </div></div>
   </section>
   <section className="workspace-menu-page" data-workspace-page="projects" hidden={view!=='projects'} inert={view!=='projects'}>
    {back('切换项目')}
    <div className="workspace-menu-scroll workspace-project-options" role="menu" aria-label="切换项目">
     {projects.map(project=><button key={project.id} type="button" role="menuitemradio" aria-checked={project.id===projectId} title={project.name} onClick={()=>{if(project.id===projectId)page('home');else act(()=>onSelectProject(project.id));}}><span>{project.name}</span>{project.id===projectId&&<Glyph name="check" size={14}/>}</button>)}
     {!projects.length&&<p className="workspace-menu-description">暂无项目</p>}
    </div>
    <footer className="workspace-menu-footer"><button type="button" className="workspace-utility-action" disabled={!connected} onClick={()=>{setDraft('');page('create');}}><Glyph name="plus" size={15}/><span>新建项目</span></button></footer>
   </section>
   <section className="workspace-menu-page" data-workspace-page="manage" hidden={view!=='manage'} inert={view!=='manage'}>
    {back('项目管理')}
    <div className="workspace-menu-scroll"><div className="workspace-menu-project-context"><strong>{managedProject?.name}</strong><small>当前项目</small></div><button type="button" className="workspace-utility-action" disabled={!connected} onClick={()=>act(onToggleBulk)}><Glyph name="layers" size={15}/><span>{bulkMode?'完成批量管理':'批量管理'}</span></button></div>
    <footer className="workspace-menu-footer"><button type="button" className="workspace-utility-action danger-text" disabled={!connected||!managedProject} onClick={()=>page('delete')}><Glyph name="trash" size={15}/><span>删除项目…</span></button></footer>
   </section>
   <section className="workspace-menu-page" data-workspace-page="create" hidden={view!=='create'} inert={view!=='create'}>
    {back('新建项目')}
    <form className="workspace-menu-form" onSubmit={event=>{event.preventDefault();void work('create');}}>
     <div className="workspace-menu-scroll"><label htmlFor={nameId}>项目名称</label><input id={nameId} value={draft} onChange={event=>setDraft(event.target.value)} placeholder="例如：生产环境" autoComplete="off" required disabled={!!busy} aria-invalid={!!error} aria-describedby={error?errorId:undefined}/>{view==='create'&&errorMessage}</div>
     <footer className="workspace-menu-footer"><button type="submit" className="button primary" disabled={!connected||!!busy||!draft.trim()}>{busy==='create'?'正在创建…':'创建项目'}</button></footer>
    </form>
   </section>
   <section className="workspace-menu-page" data-workspace-page="delete" hidden={view!=='delete'} inert={view!=='delete'}>
    {back('删除项目')}
    <div className="workspace-menu-scroll"><div className="workspace-menu-project-context"><strong>删除「{managedProject?.name}」？</strong></div><p className="workspace-menu-description">项目及其资源、会话会从导航中移除，配置和历史记录保留。可在“已删除”中恢复整个项目。</p>{view==='delete'&&errorMessage}</div>
    <footer className="workspace-menu-footer"><button data-delete-cancel type="button" className="workspace-utility-action" disabled={!!busy} onClick={()=>page('manage')}><span>取消</span></button><button type="button" className="workspace-utility-action danger-text" disabled={!connected||!!busy||!managedProject} onClick={()=>void work('delete')}><Glyph name="trash" size={15}/><span>{busy==='delete'?'正在删除…':'移至已删除'}</span></button></footer>
   </section>
  </div>,document.body)}
 </>;
}
