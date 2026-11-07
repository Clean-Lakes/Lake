import {useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import type {SuperWorkspace} from '../../../shared/contracts';
import {PilotWorkspace} from '../../src/PilotWorkspace';
import {SidebarPilotEntry} from '../../src/SidebarPilotEntry';
import '../../src/sidebarWorkspace.css';
import {initializeFocusModality} from '../../src/focusModality';
import '../../src/styles.css';

const params=new URLSearchParams(location.search);
if(params.has('dark'))document.documentElement.dataset.theme='dark';
initializeFocusModality();
let attempts=0;
window.fetch=async(input,options)=>{
 const path=new URL(input instanceof Request?input.url:input,location.href).pathname;
 if(options?.method==='DELETE'&&path==='/api/projects/fixture-project/superagent/specialists/role-a'){
  if(params.has('error')&&++attempts===1)return Response.json({error:'连接暂时中断，请重试'},{status:503});
  return Response.json({deleted:true});
 }
 return Response.json({error:'unexpected fixture request'},{status:404});
};
const initial:SuperWorkspace={active:true,project:{projectId:'fixture-project',routerSessionId:'pilot',version:1},workers:[],channels:[
 {id:'channel-a',projectId:'fixture-project',roleId:'role-a',roleName:'发布专员',duties:'维护本项目的发布任务',roleRevision:1,sessionId:'session-a',revision:1,createdAt:''},
 {id:'channel-b',projectId:'fixture-project',roleId:'role-b',roleName:'数据库专员',duties:'检查数据库状态',roleRevision:1,sessionId:'session-b',revision:1,createdAt:''},
]};
function Fixture(){
 const [workspace,setWorkspace]=useState(initial),[selected,setSelected]=useState('session-a');
 const pilotButton=useRef<HTMLButtonElement|null>(null);
 return <main style={{fontFamily:'var(--font-ui)',color:'var(--foreground)'}}><aside className="sidebar workspace-navigation" style={{width:'min(300px,100vw)',padding:8,height:'auto'}}>
  <div className="sidebar-brand-row"><SidebarPilotEntry selected={selected==='pilot'} buttonRef={pilotButton} onPilot={()=>setSelected('pilot')}/></div>
  <PilotWorkspace pilotButton={pilotButton} workspace={workspace} error="" selectedId={selected} onPilot={()=>setSelected('pilot')} onWorker={()=>{}} onChannel={channel=>setSelected(channel.sessionId)} onDeleted={channel=>setWorkspace(current=>({...current,channels:current.channels?.filter(row=>row.roleId!==channel.roleId)}))}/>
 </aside><output aria-label="当前会话">{selected}</output></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
