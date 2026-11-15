import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {AICard,SessionSnapshot,SpecialistChannelInfo} from '../../../shared/contracts';
import {AITranscript} from '../../src/AIPanel';
import {AppSelect} from '../../src/AppSelect';
import {lakeAvatarCatalog,type LakeAvatarName} from '../../src/lakeAvatarCatalog';
import {SpecialistAvatarProvider} from '../../src/SuperRoleAvatar';
import {PilotSpecialistReplyView} from '../../src/PilotSpecialistConversation';
import type {PilotSpecialistRow} from '../../src/pilotSpecialistReplies';
import '../../src/styles.css';
import '../../src/appSelect.css';
import '../../src/sessionPresentation.css';
import '../../src/conversationDirectory.css';
import '../../src/pilotWorkspace.css';
import '../../src/sreCollaboration.css';
import '../../src/specialistAvatars.css';
import '../../src/assistantProse.css';
import '../../src/conversationBubbles.css';
import '../../src/animalThinkingBubble.css';

const stages=['思考','整理上下文','工具执行','待确认','等待输入','排队','正文流式','完成','已停止','失败','断线'] as const;
type Stage=typeof stages[number];
function Preview(){
 const [stage,setStage]=useState<Stage>('思考'),[avatar,setAvatar]=useState<LakeAvatarName>('otter'),[pilot,setPilot]=useState(false),[revision,setRevision]=useState(0);
 const [liveSpecialist,setLiveSpecialist]=useState(true),[longName,setLongName]=useState(false),[opened,setOpened]=useState('');
 const [startedAt]=useState(()=>new Date(Date.now()-5000).toISOString());
 const ended=['完成','已停止','失败'].includes(stage),streaming=stage==='正文流式';
 const cards:AICard[]=stage==='整理上下文'?[{id:'compact',at:startedAt,type:'compaction',status:'running',content:'正在压缩上下文…'}]:stage==='工具执行'?[{id:'tool',at:startedAt,type:'operation',title:'inspect_host',status:'running'}]:stage==='待确认'?[{id:'approval',at:startedAt,type:'operation',title:'run_command',status:'pending'}]:streaming||ended?[{id:'reply',at:startedAt,type:'message',status:streaming?'running':'completed',content:'这是实际回复。角色思考气泡在正文出现后收起。'}]:[];
 const status=stage==='完成'?'completed':stage==='已停止'?'cancelled':stage==='失败'?'failed':stage==='待确认'?'waiting_approval':stage==='等待输入'?'waiting_input':stage==='排队'?'queued':'running';
 const channel={id:'fixture-channel',roleId:'fixture-role',sessionId:'fixture-session',projectId:'fixture-project',roleName:'角色验证专员',avatarId:avatar,revision,createdAt:startedAt,running:!ended} as SpecialistChannelInfo;
 const snapshot={session:{id:'fixture-session',projectId:'fixture-project',workspaceRole:pilot?'router':'worker'},messages:[{id:'fixture-user',sessionId:'fixture-session',role:'user',text:'梳理渠道接入后的处理流程。',createdAt:startedAt}],resources:[],actions:[],replyTimings:[{messageId:'fixture-user',startedAt,status:ended?status:'running',finishedAt:ended?new Date(Date.parse(startedAt)+4000).toISOString():''}],ai:{session:'fixture-session',status,turnStartedAt:startedAt,cards,cardsOffset:0,replyStatus:streaming?'running':undefined}} as SessionSnapshot;
 const name=longName?'负责跨渠道消息路由与任务处理流程的角色验证专员':'角色验证专员';
 const task={taskId:'fixture-task',sessionId:'fixture-session',projectId:'fixture-project',title:'核对当前状态',state:'running',acceptanceState:'not_evaluated',revision:1} as const;
 const row:PilotSpecialistRow={projectId:'fixture-project',sourceMessageId:'fixture-user',sourceCreatedAt:startedAt,reportedTurns:[],worker:{id:'fixture-worker',roleId:channel.roleId,roleName:name,sessionId:'fixture-session',assignmentState:'active',task},activity:{phase:stage==='工具执行'?'tool':stage==='待确认'?'waiting_approval':stage==='等待输入'?'waiting_input':stage==='排队'?'queued':'thinking',label:stage==='工具执行'?'正在执行工具':stage==='待确认'?'等待确认':stage==='等待输入'?'等待你补充信息':stage==='排队'?'排队等待':'正在思考',updatedAt:startedAt},author:{kind:'specialist',name,roleId:channel.roleId,workerId:'fixture-worker',sessionId:'fixture-session',taskId:task.taskId,execution:{kind:'native'}}};
 const liveSnapshot:SessionSnapshot={...snapshot,superagent:{roleId:channel.roleId,task} as SessionSnapshot['superagent'],ai:{...snapshot.ai!,rootTurnId:'fixture-root',cards:cards.map(card=>({...card,data:{root_turn_id:'fixture-root'}}))}};
 return <main style={{maxWidth:860,margin:'28px auto',padding:'0 20px'}}>
  <header style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginBottom:32}}>
   <label style={{minWidth:140}}>角色<AppSelect label="思考角色" value={avatar} onChange={event=>setAvatar(event.target.value as LakeAvatarName)}>{lakeAvatarCatalog.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</AppSelect></label>
   <button type="button" onClick={()=>setPilot(value=>!value)}>{pilot?'切换专员':'切换 Pilot'}</button>
   <button type="button" onClick={()=>setLiveSpecialist(value=>!value)}>{liveSpecialist?'切换会话状态':'切换 Pilot 实时专员'}</button>
   <button type="button" onClick={()=>setLongName(value=>!value)}>{longName?'使用短名称':'使用长名称'}</button>
   <button type="button" onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>切换主题</button>
   <button type="button" onClick={()=>setRevision(value=>value+1)}>无关快照更新</button>
   {stages.map(value=><button key={value} type="button" aria-pressed={stage===value} onClick={()=>setStage(value)}>{value}</button>)}
  </header>
  <p data-fixture-stage={stage} style={{marginBottom:24}}>状态：{stage} · 快照 {revision}</p>
  {opened&&<p data-opened-role={opened}>已打开专员：{opened}</p>}
  <SpecialistAvatarProvider channels={[channel]}>{liveSpecialist?<div className="ai-transcript" data-transcript-mode="conversation"><PilotSpecialistReplyView row={row} snapshot={liveSnapshot} available={stage!=='断线'} onSpecialist={author=>setOpened(author.roleId??'')}/></div>:<AITranscript snapshot={snapshot} connected={stage!=='断线'} assistantIdentity={pilot?{name:'Pilot',pilot:true}:{name:'角色验证专员',roleId:channel.roleId}}/>}</SpecialistAvatarProvider>
 </main>;
}
document.documentElement.dataset.theme='light';
createRoot(document.getElementById('root')!).render(<Preview/>);
