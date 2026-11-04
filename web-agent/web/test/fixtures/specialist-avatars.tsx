import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SuperRoleAvatar} from '../../src/SuperRoleAvatar';
import {PilotWorkspace} from '../../src/PilotWorkspace';
import {AITranscript} from '../../src/AIPanel';
import {ReplyIdentity} from '../../src/ReplyIdentity';
import {SuperTaskInspector} from '../../src/SuperTaskInspector';
import {lakeAvatarCatalog} from '../../src/lakeAvatarCatalog';
import {AppSelect} from '../../src/AppSelect';
import {superWorkerAppearance,conversationAvatarMotion,type ConversationActivity} from '../../src/superAgentPresentation';
import type {SessionSnapshot,SuperTask,SuperWorkspace,WorkGoal} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/appSelect.css';
import '../../src/sreCollaboration.css';
import '../../src/pilotWorkspace.css';
import '../../src/specialistAvatars.css';
import './specialist-avatars.css';

const names=['数据库专员','发布专员','服务巡检专员','网络专员','测试专员','代码专员','文档专员','调度专员'];
const sampleRoles:Array<{id:string;name:string}>=[],seen=new Set();
for(let i=0;seen.size<8;i++){
 const id=`avatar-preview-${i}`,icon=superWorkerAppearance({roleId:id,roleName:''}).icon;
 if(!seen.has(icon)){seen.add(icon);sampleRoles.push({id,name:names[sampleRoles.length]});}
}
const libraryRoles:Array<{id:string;name:string}>=[],librarySeen=new Set();
for(let i=0;librarySeen.size<100;i++){
 const id=`conversation-preview-${i}`,icon=superWorkerAppearance({roleId:id,roleName:''}).icon;
 if(!librarySeen.has(icon)){librarySeen.add(icon);libraryRoles.push({id,name:lakeAvatarCatalog.find(row=>row.id===icon)!.name});}
}
function Preview(){
 const [activity,setActivity]=useState<ConversationActivity>('running'),[dark,setDark]=useState(false),[state,setState]=useState<SuperTask['state']>('running'),[roles,setRoles]=useState(sampleRoles),[selected,setSelected]=useState(sampleRoles[0].id);
 const chosen=roles.find(role=>role.id===selected)!,running=state==='running';
 const task=(id:string):SuperTask=>({taskId:'task-'+id,sessionId:'worker-'+id,title:'查询当前账号可见发布单总数',state:id===selected?state:'completed',acceptanceState:id===selected?'not_evaluated':'pass',revision:1,originRootTurnId:'preview',deadlineAt:''});
 const workers=roles.slice(0,8).map(role=>({id:'worker-'+role.id,roleId:role.id,roleName:role.name,sessionId:'worker-'+role.id,task:task(role.id),assignmentState:role.id===selected&&running?'active':'parked'}));
 const workspace:SuperWorkspace={active:true,project:{projectId:'preview',routerSessionId:'pilot',version:1},workers,channels:roles.map(role=>({id:'channel-'+role.id,roleId:role.id,roleName:role.name,projectId:'preview',sessionId:'channel-'+role.id,revision:1,createdAt:'',duties:'界面预览，无真实执行',running:workers.some(worker=>worker.roleId===role.id&&worker.assignmentState==='active'),needsConfirmation:workers.some(worker=>worker.roleId===role.id)&&role.id===selected&&state==='waiting_user'}))};
 const startedAt='2026-11-04T00:00:00Z';
 const previewSnapshot={session:{id:'pilot',title:'Pilot',projectId:'preview',status:'investigating'},resources:[],messages:[{id:'preview-user',sessionId:'pilot',role:'user',text:'头像会话预览，不执行真实查询',createdAt:startedAt}],actions:[],evidence:[],ai:{session:'pilot',status:activity==='running'?'running':activity==='waiting'?'waiting_approval':'completed',turnStartedAt:startedAt,cards:[{id:'preview-reply',type:'message',status:activity==='running'?'running':'completed',content:'正在核对查询结果。',at:startedAt}],usage:{},profile:'',turns:1,cardsOffset:0,totalCards:1}} as unknown as SessionSnapshot;
 const owner=workers.find(worker=>worker.roleId===selected);
 return <section className="avatar-preview">
  <header><div><h1>Lake 专员头像</h1><p>独立界面夹具，不连接模型或项目资源。</p></div><button className="button" onClick={()=>{document.documentElement.dataset.theme=dark?'light':'dark';setDark(!dark)}}>{dark?'切换浅色':'切换深色'}</button></header>
  <div className="preview-controls"><label>当前任务<AppSelect aria-label="预览任务状态" value={state} onChange={e=>setState(e.target.value as SuperTask['state'])}><option value="running">执行中</option><option value="waiting_user">待确认</option><option value="paused">已暂停</option><option value="completed">已完成</option></AppSelect></label><button className="button" onClick={()=>{const next={id:'new-role-'+roles.length,name:'新建自定义专员 '+(roles.length-7)};setRoles([...roles,next]);setSelected(next.id)}}>新建预览专员</button><span>新专员不附带任务</span><label>实际会话<AppSelect aria-label="预览会话活动" value={activity} onChange={e=>setActivity(e.target.value as ConversationActivity)}><option value="running">正在回复</option><option value="waiting">等待确认</option><option value="idle">回复结束</option></AppSelect></label></div>
  <div className="preview-grid"><aside className="sidebar workspace-navigation"><PilotWorkspace activity={{sessionId:'channel-'+selected,state:activity}} pilotActivity={activity} workspace={workspace} selectedId={'channel-'+selected} error="" onPilot={()=>{}} onWorker={()=>{}} onChannel={channel=>setSelected(channel.roleId)}/></aside>
   <section className="preview-conversation"><div className="preview-heading"><span id="hero-avatar"><SuperRoleAvatar roleId={chosen.id} name={chosen.name} motion={conversationAvatarMotion(activity,state)}/></span><strong>{chosen.name}</strong><span>{owner?'任务状态预览':'暂无任务'}</span></div>
    <div className="preview-message"><ReplyIdentity identity={{name:'Pilot',pilot:true}} author={{kind:'specialist',name:chosen.name,roleId:chosen.id,workerId:'worker-'+chosen.id,sessionId:'worker-'+chosen.id,taskId:'task-'+chosen.id}}/><p>查到了，当前账号可见的发布单共有 917 单。</p></div>
    <div className="preview-message" id="live-reply"><AITranscript snapshot={previewSnapshot} assistantIdentity={{name:'Pilot',pilot:true}}/></div><div className="preview-gallery">{libraryRoles.map(role=><div key={role.id}><SuperRoleAvatar roleId={role.id} name={role.name} motion={conversationAvatarMotion(activity)}/><span>{role.name}</span></div>)}</div>
   </section><section className="preview-inspector">{owner?<SuperTaskInspector task={task(chosen.id)} goal={{items:[],modelRounds:1,roundLimit:10} as unknown as WorkGoal} worker={owner}/>:<p>新专员已创建，可先沟通再派任务。</p>}</section>
  </div>
 </section>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
