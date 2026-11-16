// Real Pilot transcript with an in-memory, exact-worker snapshot transport.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {AICard,Message,SessionSnapshot,SuperWorker,SuperWorkspace} from '../../../shared/contracts';
import {AITranscript} from '../../src/AIPanel';
import {ObjectReferencesProvider} from '../../src/AssistantMarkdown';
import {SpecialistAvatarProvider} from '../../src/SuperRoleAvatar';
import '../../src/styles.css';
import '../../src/pilotWorkspace.css';
import '../../src/specialistAvatars.css';
import '../../src/assistantProse.css';
import '../../src/conversationBubbles.css';
import '../../src/sreCollaboration.css';

const at='2026-11-16T08:00:00.000Z',started='2026-11-16T08:00:01.000Z';
const labels=['思考','首段进度','流式追加','工具执行','新段进度','活动快照空窗','完成待报告','正式报告','等待审批','断线','删除专员'] as const;
let stage=0,cursor=1;
const streams=new Set<FixtureEvents>();
class FixtureEvents extends EventTarget {
 readyState=1;onopen:(()=>void)|null=null;onerror:(()=>void)|null=null;onmessage:((event:MessageEvent)=>void)|null=null;
 constructor(){super();streams.add(this);queueMicrotask(()=>this.onopen?.());}
 close(){this.readyState=2;streams.delete(this);}
}
window.EventSource=FixtureEvents as unknown as typeof EventSource;
const author={kind:'specialist' as const,name:'服务器运维排查专员',roleId:'role-host',workerId:'worker-host',sessionId:'source-host',taskId:'task-host',rootTurnId:'sdk-current',avatarId:'flamingo' as const};
const task=()=>({taskId:author.taskId,sessionId:author.sessionId,projectId:'fixture-project',title:'公开进度连续性验收',state:[6,7].includes(stage)?'completed' as const:stage===8?'waiting_user' as const:'running' as const,acceptanceState:'not_evaluated' as const,revision:1,originRootTurnId:'task-origin',deadlineAt:''});
const worker=():SuperWorker=>({id:author.workerId,roleId:author.roleId,roleName:author.name,sessionId:author.sessionId,task:task(),assignmentState:[6,7].includes(stage)?'parked':'active',activity:[5,6,7].includes(stage)?undefined:{phase:stage===3?'tool':stage===8?'waiting_approval':'thinking',label:stage===3?'正在读取公开样例':stage===8?'等待确认':'正在分析',sourceSessionId:'pilot-fixture',sourceMessageId:'user-fixture',updatedAt:started}});
const user:Message={id:'user-fixture',sessionId:'pilot-fixture',role:'user',text:'检查隔离样例的进度更新。',createdAt:at};
function cards():AICard[]{
 if(stage===0)return [];
 const first=stage<4;
 return [{id:first?'progress-one':'progress-two',type:'message',status:'running',at:started,content:first?'我先核对公开样例的 CPU 与内存。'+(stage>=2?' 再读取磁盘与进程摘要。':''):'已取得样例数据，正在对比本轮变化并整理说明。',data:{root_turn_id:'sdk-current'}}];
}
function sourceSnapshot():SessionSnapshot{return {session:{id:author.sessionId,projectId:'fixture-project',workspaceRole:'worker'},superagent:{roleId:author.roleId,task:task()},cursor,messages:[],resources:[],actions:[],ai:{session:author.sessionId,status:stage===8?'waiting_approval':[6,7].includes(stage)?'completed':'running',replyStatus:[6,7,8].includes(stage)?undefined:'running',rootTurnId:'sdk-current',turnStartedAt:started,cards:cards(),cardsOffset:0,totalCards:cards().length}} as SessionSnapshot;}
window.fetch=async()=>Response.json(sourceSnapshot());
function Fixture(){
 const [current,setCurrent]=useState(0),[revision,setRevision]=useState(0);
 const move=(next:number)=>{stage=next;cursor++;setCurrent(next);for(const stream of streams)stream.dispatchEvent(new MessageEvent('session',{data:JSON.stringify({sessionId:author.sessionId,seq:cursor})}));};
 const workspace:SuperWorkspace={active:true,project:{projectId:'fixture-project',routerSessionId:'pilot-fixture',version:1},workers:stage===10?[]:[worker()],channels:[]};
 const report:Message={id:'report-current',sessionId:'pilot-fixture',role:'assistant',text:'本轮样例核对已结束，未连接业务资源。',createdAt:'2026-11-16T08:00:09.000Z',author};
 const snapshot={session:{id:'pilot-fixture',projectId:'fixture-project',workspaceRole:'router'},cursor:cursor+revision,messages:[user,{id:'pilot-arranged',sessionId:'pilot-fixture',role:'assistant',text:'已安排专员核对隔离样例。',createdAt:started},...(stage===7?[report]:[])],resources:[],actions:[],ai:{session:'pilot-fixture',status:'completed',cards:[],cardsOffset:0,totalCards:0}} as SessionSnapshot;
 return <main style={{maxWidth:900,margin:'20px auto',padding:'0 16px'}}>
  <header style={{display:'flex',gap:8,flexWrap:'wrap'}}>{labels.map((label,index)=><button key={label} aria-pressed={current===index} onClick={()=>move(index)}>{label}</button>)}<button onClick={()=>setRevision(value=>value+1)}>无关快照</button><button onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>切换主题</button></header>
  <p data-stage={current}>当前：{labels[current]} · 快照 {revision}。仅使用虚构本地数据。</p>
  <SpecialistAvatarProvider channels={[]}><ObjectReferencesProvider><AITranscript snapshot={snapshot} pilotWorkspace={workspace} pilotConnected={stage!==9} assistantIdentity={{name:'Pilot',pilot:true}} onSpecialist={()=>{}}/></ObjectReferencesProvider></SpecialistAvatarProvider>
 </main>;
}
document.documentElement.dataset.theme='light';
createRoot(document.getElementById('root')!).render(<Fixture/>);
