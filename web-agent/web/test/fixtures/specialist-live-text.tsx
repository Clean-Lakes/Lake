import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {AIView,SessionSnapshot,SpecialistChannelInfo} from '../../../shared/contracts';
import {PilotSpecialistReplyView} from '../../src/PilotSpecialistConversation';
import type {PilotSpecialistRow} from '../../src/pilotSpecialistReplies';
import {ObjectReferencesProvider} from '../../src/AssistantMarkdown';
import {SpecialistAvatarProvider} from '../../src/SuperRoleAvatar';
import '../../src/styles.css';
import '../../src/pilotWorkspace.css';
import '../../src/specialistAvatars.css';
import '../../src/assistantProse.css';
import '../../src/conversationBubbles.css';
import '../../src/sreCollaboration.css';
import '../../src/animalThinkingBubble.css';

const states=['无正文','公开进展','工具阶段','等待确认','断线','完成'] as const;
const sentence='我先检查这台服务器的负载、内存和磁盘使用情况。';
const richText='正在核对 **内存和磁盘**，保留 [参考链接](https://example.com) 与 `uptime`。\n\n- 第一项：CPU load average\n- 第二项：文件系统使用率\n\n```sh\nprintf "example only"\n```\n\n| 项目 | 说明 |\n| --- | --- |\n| disk | 只读示例 |\n\n末尾文本可换行，英文 words stay together，组合字符 👩🏽‍💻 é 完整保留。';
function Preview(){
 const [state,setState]=useState<typeof states[number]>('无正文');
 const [rich,setRich]=useState(false),[revision,setRevision]=useState(0),[append,setAppend]=useState(0),[opened,setOpened]=useState(false);
 const [startedAt]=useState(()=>new Date().toISOString());
 const text=(rich?richText:sentence)+' 继续确认实际信息。'.repeat(append);
 const task={taskId:'fixture-task',sessionId:'fixture-session',projectId:'fixture-project',title:'核对公开进展',state:'running',acceptanceState:'not_evaluated',revision:1} as const;
 const channel:SpecialistChannelInfo={id:'fixture-channel',roleId:'fixture-role',sessionId:'fixture-channel-session',projectId:'fixture-project',roleName:'服务器运维排查专员',avatarId:'flamingo',revision,createdAt:startedAt};
 const row:PilotSpecialistRow={projectId:'fixture-project',sourceMessageId:'fixture-source',sourceCreatedAt:startedAt,reportedTurns:[],worker:{id:'fixture-worker',roleId:channel.roleId,roleName:channel.roleName,sessionId:task.sessionId,assignmentState:'active',task},activity:{phase:state==='工具阶段'?'tool':state==='等待确认'?'waiting_approval':'thinking',label:state==='工具阶段'?'正在检查资源':state==='等待确认'?'等待确认':'正在分析',updatedAt:startedAt},author:{kind:'specialist',name:channel.roleName,roleId:channel.roleId,avatarId:channel.avatarId,workerId:'fixture-worker',sessionId:task.sessionId,taskId:task.taskId,execution:{kind:'acp',agent:'codex'}}};
 const ai:AIView={session:task.sessionId,profile:'',turns:1,totalCards:state==='无正文'?0:1,usage:{},status:state==='完成'?'completed':state==='等待确认'?'waiting_approval':'running',replyStatus:state==='完成'?undefined:'running',turnStartedAt:startedAt,rootTurnId:'fixture-root',cardsOffset:0,cards:state==='无正文'?[]:[{id:'fixture-public-reply',type:'message',at:startedAt,status:state==='完成'?'completed':'running',content:text,data:{root_turn_id:'fixture-root'}}]};
 const snapshot={session:{id:task.sessionId,projectId:task.projectId},superagent:{roleId:channel.roleId,task},ai,cursor:revision,messages:[],resources:[],actions:[]} as unknown as SessionSnapshot;
 return <main style={{maxWidth:850,margin:'28px auto',padding:'0 20px'}}>
  <header style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:24}}>
   {states.map(value=><button key={value} type="button" aria-pressed={state===value} onClick={()=>setState(value)}>{value}</button>)}
   <button type="button" onClick={()=>setAppend(n=>n+1)}>继续追加</button>
   <button type="button" onClick={()=>setRich(v=>!v)}>{rich?'普通文本':'Markdown 示例'}</button>
   <button type="button" onClick={()=>setRevision(v=>v+1)}>无关快照更新</button>
   <button type="button" onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>切换主题</button>
  </header>
  <p data-state={state}>状态：{state} · 快照 {revision}</p>
  {opened&&<p data-opened-role="fixture-role">已打开准确专员入口</p>}
  <SpecialistAvatarProvider channels={[channel]}><ObjectReferencesProvider><div className="ai-transcript" data-transcript-mode="conversation"><div className="ai-turn">
   <p data-before-reply>已安排专员检查。</p>
   <div className="pilot-specialist-conversation"><PilotSpecialistReplyView row={row} snapshot={snapshot} available={state!=='断线'} onSpecialist={()=>setOpened(true)}/></div>
   <p data-after-reply>后续记录</p>
  </div></div></ObjectReferencesProvider></SpecialistAvatarProvider>
 </main>;
}
document.documentElement.dataset.theme='light';
createRoot(document.getElementById('root')!).render(<Preview/>);
