import {useLayoutEffect,useRef,type ReactNode} from 'react';
import type {Project} from '../../shared/contracts';
import {Glyph} from './Icons';

export function WorkspaceProjectList({projects,projectId,onSelect}:{
 projects:readonly Project[];projectId?:string;onSelect:(project:Project)=>void;
}){
 if(!projects.length)return <p className="workspace-projects-empty">暂无项目</p>;
 return <ul className="workspace-projects-list" aria-label="项目列表">{projects.map(project=>{
  const current=project.id===projectId;
  return <li key={project.id}>
   <button type="button" className={`nav-row workspace-project-row${current?' active':''}`}
    aria-current={current?'true':undefined} title={project.name} onClick={()=>onSelect(project)}>
    <Glyph name="folder" size={17}/><span>{project.name}</span>{current&&<Glyph name="check" size={14}/>}
   </button>
  </li>;
 })}</ul>;
}

export function WorkspacePage({project,projectSelection,connected,bulkMode,modelConfigured,unreadUpdate,onOpenNavigation,
 onCreateProject,onDeleteProject,onToggleBulk,onSettings,onUpdates,onTrash}:{
 project?:Project;projectSelection?:ReactNode;connected:boolean;bulkMode:boolean;modelConfigured:boolean;unreadUpdate:boolean;
 onOpenNavigation:()=>void;onCreateProject:()=>void;onDeleteProject:(project:Project)=>void;onToggleBulk:()=>void;
 onSettings:()=>void;onUpdates:()=>void;onTrash:()=>void;
}){
 const heading=useRef<HTMLHeadingElement>(null);
 useLayoutEffect(()=>heading.current?.focus({preventScroll:true}),[]);
 return <div id="workspace-page" className="workspace-page" aria-labelledby="workspace-page-title">
  <header className="workspace-header workspace-page-header">
   <button type="button" className="icon-button mobile-only" aria-label="打开项目导航" onClick={onOpenNavigation}><Glyph name="menu" size={21}/></button>
   <h1 id="workspace-page-title" ref={heading} tabIndex={-1}>工作区</h1>
  </header>
  <div className="workspace-page-scroll">
   <div className="workspace-page-content">
    <section className="workspace-project-section" aria-labelledby="workspace-current-project-title">
     <div className="workspace-project-heading">
      <div className="workspace-project-identity">
       <span className="workspace-project-icon"><Glyph name="folder" size={21}/></span>
       <div><small id="workspace-current-project-title">当前项目</small><h2>{project?.name??'暂无项目'}</h2></div>
      </div>
      <button type="button" className="button secondary" disabled={!connected} onClick={onCreateProject}><Glyph name="plus" size={16}/>新建项目</button>
     </div>
     {project&&<div className="workspace-project-controls">
      {projectSelection}
      <button type="button" className="button secondary" disabled={!connected} onClick={onToggleBulk}><Glyph name="layers" size={16}/>{bulkMode?'完成批量管理':'批量管理'}</button>
      <button type="button" className="button secondary danger-text" disabled={!connected} onClick={()=>onDeleteProject(project)}><Glyph name="trash" size={16}/>删除项目…</button>
     </div>}
    </section>
    <section className="workspace-page-actions" aria-label="应用操作">
     <button type="button" onClick={onSettings}><Glyph name="settings" size={18}/><span>设置</span>{!modelConfigured&&<small>待配置</small>}<Glyph name="next" size={14}/></button>
     <button type="button" onClick={onUpdates}><Glyph name="refresh" size={18}/><span>检查更新</span>{unreadUpdate&&<small>新版本</small>}<Glyph name="next" size={14}/></button>
     <button type="button" disabled={!connected} onClick={onTrash}><Glyph name="trash" size={18}/><span>已删除</span><Glyph name="next" size={14}/></button>
    </section>
   </div>
  </div>
 </div>;
}
