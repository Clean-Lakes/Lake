// Component integration fixture: local presentation only; no host or model calls.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SidebarWorkspaceNavigation} from '../../src/SidebarWorkspaceNavigation';
import {SidebarPilotEntry} from '../../src/SidebarPilotEntry';
import {ConversationDirectory,conversationTurnId} from '../../src/ConversationDirectory';
import {Glyph} from '../../src/Icons';
import {ResourceTree} from '../../src/ResourceTree';
import type {Project,Resource} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/pilotWorkspace.css';
import '../../src/conversationDirectory.css';
import '../../src/focusModality';

document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')||'light';
const names=['服务器运维排查专员','ACP 测试专员','知识库专员','数据库专员','河狸专员','发布专员'];
const project={id:'navigation-fixture',name:'导航验证项目'} as Project;
const resources=Array.from({length:100},(_,index)=>({id:`r${index}`,projectId:project.id,name:`测试资源 ${index+1}`,kind:'ssh',status:'available'})) as Resource[];
const items=Array.from({length:100},(_,i)=>({id:`u${i}`,number:i+1,label:i<2?'重复提问':i===99?'全部专员给我报数！':`第 ${i+1} 轮：查看本轮记录`}));
function Fixture(){
 const [draft,setDraft]=useState('保留这份草稿'),[selection,setSelection]=useState('pilot'),[chosen,setChosen]=useState('无');
 const move=(id:string)=>{setChosen(id);document.getElementById(conversationTurnId('fixture',id))?.scrollIntoView({block:'start'});};
 return <div style={{height:'100%',display:'flex',flexDirection:'column'}}>
  <header style={{padding:'8px 16px',fontSize:12}}><output>最近跳转：{chosen}</output></header>
  <div className="app-shell" style={{flex:1,minHeight:0}}>
   <aside className="sidebar workspace-navigation sidebar-open" style={{position:'relative',transform:'none',flex:'0 0 280px',width:280}}>
    <div className="sidebar-brand-row"><span className="brand"><strong>Lake</strong></span></div>
    <SidebarWorkspaceNavigation projectId="navigation-fixture" resourceCount={100} selectionId={selection} selectedPanel={selection.startsWith('resource:')?'resources':'specialists'} attention
     pilot={<SidebarPilotEntry selected={selection==='pilot'} onPilot={()=>setSelection('pilot')}/>}
     specialists={<section className="pilot-workspace">{names.map(name=><button key={name} className="nav-row pilot-worker-row" type="button" onClick={()=>setSelection(name)}><Glyph name="chat" size={18}/><span className="nav-row-text"><strong>{name}</strong><span className="pilot-worker-task">持续沟通</span></span></button>)}</section>}>
     <ResourceTree navigationPanel project={project} resources={resources} nodes={[]} disabled={false} refresh={async()=>{}} onAddResource={()=>setChosen('新增资源')} onImport={()=>setChosen('导入资源')} onDelete={()=>{}} renderResource={resource=><button className="nav-row resource-row" type="button" onClick={()=>setSelection(`resource:${resource.id}`)}><Glyph name="server" size={16}/><span className="nav-row-text"><strong>{resource.name}</strong></span></button>}/>
    </SidebarWorkspaceNavigation>
    <footer className="sidebar-footer">工作区</footer>
   </aside>
   <main className="workspace" style={{display:'flex',flexDirection:'column',minWidth:0}}>
    <div className="conversation" style={{scrollPaddingTop:80}}><div className="timeline-list"><div className="ai-transcript">
     <ConversationDirectory sessionId="fixture" items={items} onJump={move} onLatest={()=>move(items.at(-1)!.id)}/>
     {items.map(item=><section id={conversationTurnId('fixture',item.id)} key={item.id} style={{minHeight:130}}><p>{item.label}</p><p>这一轮的原始回复。</p></section>)}
    </div></div></div>
    <label style={{padding:16}}>草稿<input aria-label="会话草稿" value={draft} onChange={event=>setDraft(event.target.value)}/></label>
   </main>
  </div>
 </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
