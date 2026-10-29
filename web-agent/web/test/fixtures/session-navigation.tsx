// Real sidebar components with fictional sessions; no model or backend requests.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {WorkSession} from '../../../shared/contracts';
import {SessionStatusDot} from '../../src/SessionStatusDot';
import {SessionStateBadge} from '../../src/SessionPresentation';
import {SessionNavigation} from '../../src/SessionNavigation';
import {SessionActions,SessionListTags} from '../../src/SessionPresentation';
import {sortSessionNavigation} from '../../src/sessionNavigationModel';
import {Glyph} from '../../src/Icons';
import '../../src/styles.css';
import '../../src/sidebarWorkspace.css';
import '../../src/sessionPresentation.css';
const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.has('dark')?'dark':'light';
const initial:Array<WorkSession>=['数据库迁移检查','服务器运行进程排查','会话状态查询','主机资源清单查询','南京今天天气查询','服务器内存占用排查','服务器状态检查','比较长的会话标题，检查文字省略以及图标与操作是否重叠'].map((title,i)=>({id:`s${i}`,projectId:'fixture',title,status:(['idle','investigating','waiting_approval','completed','failed'] as const)[i%5]!,resourceIds:[],createdAt:`2026-10-${22-i}T09:00:00Z`,updatedAt:`2026-10-${22-i}T09:00:00Z`,navigationRevision:0,tags:i===4?[{id:'tag',name:'运维排查',projectId:'fixture',color:'green'}]:[]}));
function Fixture(){
 const [sessions,setSessions]=useState(initial),[all,setAll]=useState(false),[selected,setSelected]=useState('s0'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[bulk,setBulk]=useState(false);
 const move=async(session:WorkSession,pinned:boolean,beforeId:string|null)=>{
  if(params.has('error'))throw Error('会话顺序已更新，请刷新后重试');
  setBusy(true);
  const group=sortSessionNavigation(sessions.filter(s=>s.id!==session.id&&!!s.pinned===pinned));
  const at=beforeId?group.findIndex(s=>s.id===beforeId):group.length;group.splice(at,0,{...session,pinned});
  setSessions(rows=>rows.map(row=>{const index=group.findIndex(s=>s.id===row.id);return{...row,...(index<0?{}:{pinned,navigationPosition:index}),navigationRevision:(row.navigationRevision??0)+1};}));setBusy(false);
 };
 return <main style={{display:'flex',height:'100dvh'}}>
  <aside className="sidebar workspace-navigation" style={{width:320,maxWidth:'100%',padding:'20px 13px'}}>
   <div className="brand" style={{marginBottom:26}}>Lake</div>
   <div className="project-scroll" style={{margin:0,padding:0}}>
    <SessionNavigation sessions={sessions} selectedId={selected} showAll={all} bulkMode={bulk} disabled={busy} onMove={move} onShowAll={()=>setAll(!all)} renderSession={session=><div className="nav-row-wrap">
     <button type="button" className={`nav-row session-nav-row${selected===session.id?' active':''}`} onClick={()=>setSelected(session.id)}>
      <Glyph name="chat" size={16}/><span className="nav-row-text"><strong>{session.title}</strong><SessionListTags tags={session.tags??[]}/></span><SessionStatusDot session={session}/>
     </button>
     <SessionActions session={session} tags={[]} view="" hasViews={false} disabled={busy} onSaved={()=>{}} onRefresh={async()=>{}} onEdit={()=>{}} className="session-more" label={`管理会话 ${session.title}`} onView={()=>{}}
      onPin={()=>void move(session,!session.pinned,sortSessionNavigation(sessions.filter(s=>!!s.pinned!==!!session.pinned))[0]?.id??null).catch(e=>setError(e.message))}/>
    </div>}/>
   </div>
  </aside>
  <div style={{padding:20}}>
   {sessions.slice(0,5).map(session=><div key={session.id} data-reference-status={session.status}><SessionStateBadge session={session}/></div>)}
   <button type="button" onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>切换主题</button>
   <button type="button" onClick={()=>setBulk(!bulk)}>批量选择</button>
   <button type="button" onClick={()=>setSessions(rows=>rows.map(s=>s.id==='s7'?{...s,updatedAt:'2026-12-01T00:00:00Z'}:s))}>模拟旧会话回复</button>
   {error&&<p role="alert">{error}</p>}
   <output id="session-navigation-proof">{JSON.stringify(sortSessionNavigation(sessions).map(s=>({id:s.id,pinned:!!s.pinned,position:s.navigationPosition})))}</output>
  </div>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
