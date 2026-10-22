// Real status and context components; isolated state, no backend/model requests.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ContextUsage} from '../../src/ContextUsage';
import {SessionStateBadge} from '../../src/SessionPresentation';
import {sreSessionPresentation} from '../../src/sreSessionPresentation';
import type {AIView,WorkSession,SRETask} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/sessionPresentation.css';
const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.get('theme')||'light';
function Preview(){
 const [status,setStatus]=useState<WorkSession['status']>('completed'),[used,setUsed]=useState(params.has('warning')?90:5),[theme,setTheme]=useState(params.get('theme')||'light'),[needsCheck,setNeedsCheck]=useState(false);
 const session={id:'ring-preview',title:'上下文状态同步',status} as WorkSession;
 const tasks=needsCheck?[{status:'completed',outcome:'inconclusive',attempts:[]} as unknown as SRETask]:[];
 const presentation=sreSessionPresentation(session,tasks);
 const currentStatus=presentation.status??session.status;
 const view={session:session.id,status:status==='investigating'?'running':status,usage:{known:true,total:used},context:{window:100,windowSource:'settings',budget:100,inputBudget:100,usedKnown:true,used}} as AIView;
 return <main style={{maxWidth:620,margin:'20px 0',padding:20}}><h2>会话状态与上下文</h2><div style={{border:'1px solid var(--border)',borderRadius:20,padding:24,background:'var(--background)'}}><header style={{display:'flex',alignItems:'center',gap:12}}>上下文状态同步<SessionStateBadge session={session} {...presentation}/></header><p style={{margin:'50px 0',color:'var(--text-secondary)'}}>上方状态与下方圆环使用同一份当前状态，切换后即时同步。</p><footer style={{display:'flex',justifyContent:'flex-end'}}><ContextUsage view={view} status={currentStatus} compact/></footer></div><nav style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:20}}>{([['idle','待命'],['investigating','调查中'],['waiting_approval','待确认'],['completed','回复结束'],['failed','需要关注']] as const).map(([value,label])=><button className="button secondary" key={value} onClick={()=>setStatus(value)}>{label}</button>)}<button className="button secondary" onClick={()=>setUsed(used===5?90:5)}>切换占用</button><button className="button secondary" onClick={()=>setNeedsCheck(!needsCheck)}>切换 SRE 结论</button><button className="button secondary" onClick={()=>{const next=theme==='dark'?'light':'dark';setTheme(next);document.documentElement.dataset.theme=next;}}>切换主题</button></nav></main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
