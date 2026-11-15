import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {AICard,SessionSnapshot,SpecialistChannelInfo} from '../../../shared/contracts';
import {AITranscript} from '../../src/AIPanel';
import {AppSelect} from '../../src/AppSelect';
import {lakeAvatarCatalog,type LakeAvatarName} from '../../src/lakeAvatarCatalog';
import {SpecialistAvatarProvider} from '../../src/SuperRoleAvatar';
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
 const [startedAt]=useState(()=>new Date(Date.now()-5000).toISOString());
 const ended=['完成','已停止','失败'].includes(stage),streaming=stage==='正文流式';
 const cards:AICard[]=stage==='整理上下文'?[{id:'compact',at:startedAt,type:'compaction',status:'running',content:'正在压缩上下文…'}]:stage==='工具执行'?[{id:'tool',at:startedAt,type:'operation',title:'inspect_host',status:'running'}]:stage==='待确认'?[{id:'approval',at:startedAt,type:'operation',title:'run_command',status:'pending'}]:streaming||ended?[{id:'reply',at:startedAt,type:'message',status:streaming?'running':'completed',content:'这是实际回复。角色思考气泡在正文出现后收起。'}]:[];
 const status=stage==='完成'?'completed':stage==='已停止'?'cancelled':stage==='失败'?'failed':stage==='待确认'?'waiting_approval':stage==='等待输入'?'waiting_input':stage==='排队'?'queued':'running';
 const channel={id:'fixture-channel',roleId:'fixture-role',sessionId:'fixture-session',projectId:'fixture-project',roleName:'角色验证专员',avatarId:avatar,revision,createdAt:startedAt,running:!ended} as SpecialistChannelInfo;
 const snapshot={session:{id:'fixture-session',projectId:'fixture-project',workspaceRole:pilot?'router':'worker'},messages:[{id:'fixture-user',sessionId:'fixture-session',role:'user',text:'梳理渠道接入后的处理流程。',createdAt:startedAt}],resources:[],actions:[],replyTimings:[{messageId:'fixture-user',startedAt,status:ended?status:'running',finishedAt:ended?new Date(Date.parse(startedAt)+4000).toISOString():''}],ai:{session:'fixture-session',status,turnStartedAt:startedAt,cards,cardsOffset:0,replyStatus:streaming?'running':undefined}} as SessionSnapshot;
 return <main style={{maxWidth:860,margin:'28px auto',padding:'0 20px'}}>
  <header style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center',marginBottom:32}}>
   <label style={{minWidth:140}}>角色<AppSelect label="思考角色" value={avatar} onChange={event=>setAvatar(event.target.value as LakeAvatarName)}>{lakeAvatarCatalog.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</AppSelect></label>
   <button type="button" onClick={()=>setPilot(value=>!value)}>{pilot?'切换专员':'切换 Pilot'}</button>
   <button type="button" onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>切换主题</button>
   <button type="button" onClick={()=>setRevision(value=>value+1)}>无关快照更新</button>
   {stages.map(value=><button key={value} type="button" aria-pressed={stage===value} onClick={()=>setStage(value)}>{value}</button>)}
  </header>
  <p data-fixture-stage={stage} style={{marginBottom:24}}>状态：{stage} · 快照 {revision}</p>
  <SpecialistAvatarProvider channels={[channel]}><AITranscript snapshot={snapshot} connected={stage!=='断线'} assistantIdentity={pilot?{name:'Pilot',pilot:true}:{name:'角色验证专员',roleId:channel.roleId}}/></SpecialistAvatarProvider>
 </main>;
}
document.documentElement.dataset.theme='light';
createRoot(document.getElementById('root')!).render(<Preview/>);
