// Real workspace component; project mutations remain in memory for UI acceptance.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SidebarUtilities} from '../../src/SidebarUtilities';
import type {Project} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/sessionPresentation.css';
import '../../src/sidebarWorkspace.css';
import '../../src/windowCorners.css';
import '../../src/surfaceGeometry.css';
const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.has('dark')?'dark':'light';
if(params.has('corner-fallback'))document.documentElement.classList.add('lake-corner-fallback');
window.lakeDesktopUpdates={development:true,platform:'macOS Dev fixture',command:async()=>({status:'current',currentVersion:'0.3.22',message:'虚构更新状态',updateAvailable:false})};
const names=['HexHub 服务器','测试','Lake Pilot 长任务验收 2026','Lake Pilot 重跑隔离验收 2026'];
if(params.has('two'))names.length=2;
if(params.has('many'))names.push(...Array.from({length:40},(_,i)=>`项目 ${i+5} · 只读验收`));
const initial:Project[]=names.map((name,i)=>({id:`workspace-${i}`,name,createdAt:'2026-10-28T00:00:00Z'}));
const calls:{operation:string;value:string}[]=[];
let fail=false,delay=200;
Object.assign(window,{lakeWorkspaceMenuQA:{calls,failure(value:boolean){fail=value},delay(value:number){delay=value}}});
function Preview(){
 const [projects,setProjects]=useState(initial),[selected,setSelected]=useState((params.has('last')?initial.at(-1):initial[0])!.id),[bulk,setBulk]=useState(false);
 async function mutation(operation:string,value:string){calls.push({operation,value});await new Promise(resolve=>setTimeout(resolve,delay));if(fail)throw new Error('模拟保存失败，请重试');}
 return <div className="app-shell" style={{gridTemplateColumns:`${params.get('sidebar')??280}px minmax(0,1fr)`}}>
  <aside className="sidebar workspace-navigation sidebar-open" style={{position:'relative',width:'100%',minWidth:0}} aria-label="项目导航">
   <div className="sidebar-brand-row"><strong>Lake Dev</strong></div>
   <div className="sidebar-workspace-navigation"/>
   <SidebarUtilities projects={projects} projectId={selected} bulkMode={bulk} onToggleBulk={()=>{setBulk(value=>!value);calls.push({operation:'bulk',value:selected})}} onSelectProject={id=>{setSelected(id);calls.push({operation:'select',value:id})}}
    onCreateProject={async name=>{await mutation('create',name);const project={id:`created-${calls.length}`,name,createdAt:'2026-10-28T00:00:00Z'};setProjects(items=>[...items,project]);setSelected(project.id)}}
    onDeleteProject={async project=>{await mutation('delete',project.id);setProjects(items=>items.filter(item=>item.id!==project.id));setSelected(projects.find(item=>item.id!==project.id)?.id??'')}}
    onSettings={()=>calls.push({operation:'settings',value:''})} onTrash={()=>calls.push({operation:'trash',value:''})} booting={false} connected modelConfigured/>
  </aside>
  <main style={{padding:24,minWidth:0}}><button type="button" className="button secondary" id="outside-target">内容区</button></main>
 </div>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
