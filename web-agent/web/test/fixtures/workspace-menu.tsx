// Real workspace page and rail with in-memory project navigation.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {Project} from '../../../shared/contracts';
import {SidebarWorkspaceNavigation} from '../../src/SidebarWorkspaceNavigation';
import {WorkspacePage,WorkspaceProjectList} from '../../src/WorkspacePage';
import '../../src/styles.css';
import '../../src/workspacePage.css';
import '../../src/windowCorners.css';

const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.has('dark')?'dark':'light';
if(params.has('corner-fallback'))document.documentElement.classList.add('lake-corner-fallback');
const names=['默认项目','测试','Lake Pilot 长任务验收'];
if(params.has('many'))names.push(...Array.from({length:40},(_,i)=>`项目 ${i+4}`));
const projects:Project[]=params.has('empty')?[]:names.map((name,i)=>({id:`workspace-${i}`,name,createdAt:'2026-11-23T01:00:00Z'}));

function Preview(){
 const [current,setCurrent]=useState(projects[0]);
 const [action,setAction]=useState(''),[bulk,setBulk]=useState(false);
 return <div className="app-shell">
  <aside className="sidebar workspace-navigation sidebar-open" aria-label="项目导航">
   <div className="sidebar-brand-row"><span className="brand"><strong>Lake</strong></span></div>
   <SidebarWorkspaceNavigation projectId={current?.id} pilot={null} specialists={null} resourceCount={0} selectionId={current?.id??''} selectedPanel="specialists"
    workspace={{active:true,unreadUpdate:false,onOpen:()=>{},projects:<WorkspaceProjectList projects={projects} projectId={current?.id} onSelect={setCurrent}/>}}>
    {null}
   </SidebarWorkspaceNavigation>
  </aside>
  <main className="workspace is-workspace-page">
   <WorkspacePage project={current} connected bulkMode={bulk} modelConfigured unreadUpdate={false} onOpenNavigation={()=>{}}
    onCreateProject={()=>setAction('新建项目')} onDeleteProject={()=>setAction('删除项目')} onToggleBulk={()=>setBulk(value=>!value)}
    onSettings={()=>setAction('设置')} onUpdates={()=>setAction('检查更新')} onTrash={()=>setAction('已删除')}/>
   <output className="visually-hidden">{action}</output>
  </main>
 </div>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
