// Real workspace page and rail with in-memory project navigation.
import {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {Project} from '../../../shared/contracts';
import {SidebarWorkspaceNavigation} from '../../src/SidebarWorkspaceNavigation';
import {WorkspacePage} from '../../src/WorkspacePage';
import {WorkspaceConsole} from '../../src/WorkspaceConsole';
import type {ConsolePage} from '../../src/workspaceConsoleTabs';
import {WorkbenchShell} from '../../src/WorkbenchNavigation';
import {Glyph} from '../../src/Icons';
import '../../src/workbenchLayout.js';
import '../../src/styles.css';
import '../../src/workspacePage.css';
import '../../src/windowCorners.css';

const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.has('dark')?'dark':'light';
if(params.has('corner-fallback'))document.documentElement.classList.add('lake-corner-fallback');
const names=['默认项目','测试','Lake Pilot 长任务验收'];
if(params.has('many'))names.push(...Array.from({length:40},(_,i)=>`Project ${i+4} · 专员与资源目录测试`));
const projects:Project[]=params.has('empty')?[]:names.map((name,i)=>({id:`workspace-${i}`,name,createdAt:'2026-11-23T01:00:00Z'}));
const resources=Array.from({length:313},()=>({projectId:'workspace-0'}));

function Preview(){
 const [current,setCurrent]=useState(projects[0]);
 const [open,setOpen]=useState(true),[page,setPage]=useState<ConsolePage>('workspace');
 const consoleRef=useRef<HTMLDialogElement>(null);
 const [navigationOpen,setNavigationOpen]=useState(false);
 const [action,setAction]=useState(''),[bulk,setBulk]=useState(false);
 const [selection,setSelection]=useState<string[]>([]);
 const compact=matchMedia('(max-width:700px)').matches;
 const mark=(id:string)=>setSelection(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id]);
 return <WorkbenchShell className="app-shell has-workbench-navigation" compact={compact} inspectorOpen={false} back={false} forward={false} onStep={()=>{}}>
  {navigationOpen&&<button className="mobile-scrim" aria-label="关闭项目导航" onClick={()=>setNavigationOpen(false)}/>}
  <aside className={`sidebar workspace-navigation${navigationOpen?' sidebar-open':''}`} aria-label="项目导航" inert={compact&&!navigationOpen}>
   <SidebarWorkspaceNavigation projectId={current?.id} specialists={null} resourceCount={0} selectionId={current?.id??''} selectedPanel="specialists"
    header={<div className="sidebar-brand-row"><button type="button" className="mobile-only icon-button" aria-label="关闭导航"
     onClick={()=>setNavigationOpen(false)}><Glyph name="close"/></button></div>}
    workspace={{open,unreadUpdate:false,onOpen:()=>{setOpen(true);setNavigationOpen(false);}}}>
    {null}
   </SidebarWorkspaceNavigation>
  </aside>
  <main className="workspace">
   <h1>{current?.name??'Pilot'}</h1>
   <output className="visually-hidden">{action}</output>
  </main>
  <WorkspaceConsole dialogRef={consoleRef} open={open} page={page} typescriptBackend busy={false}
   onPage={setPage} onClose={()=>setOpen(false)}>
   <WorkspacePage project={current} projects={projects} resources={resources} connected bulkSelectedCount={selection.length}
    bulkSelection={bulk?{has:target=>selection.includes(target.id),toggle:target=>mark(target.id),disabled:false}:undefined}
    onClose={()=>setOpen(false)} onOpenProject={project=>{setCurrent(project);setOpen(false);setAction('进入项目');}}
    onCreateProject={()=>setAction('新建项目')} onDeleteProject={()=>setAction('删除项目')}
    onToggleBulk={()=>{setBulk(value=>!value);setSelection([]);}} onClearSelection={()=>setSelection([])} onDeleteSelected={()=>setAction('删除所选')}/>
  </WorkspaceConsole>
 </WorkbenchShell>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
