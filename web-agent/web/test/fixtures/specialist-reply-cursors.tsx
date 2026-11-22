import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {Message,SessionSnapshot} from '../../../shared/contracts';
import {PilotSpecialistReplyView} from '../../src/PilotSpecialistConversation';
import type {PilotSpecialistRow} from '../../src/pilotSpecialistReplies';
import {SpecialistReplyCursor} from '../../src/SpecialistReplyCursor';
import {lakeAvatarCatalog} from '../../src/lakeAvatarCatalog';
import '../../src/styles.css';
import '../../src/specialistAvatars.css';
import '../../src/assistantProse.css';
import '../../src/conversationBubbles.css';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.has('dark') ? 'dark' : 'light';
const at = new Date().toISOString();
const participants = [
  ['rabbit', '知识库专员', '我再核对今天可见的新建、首次发布和编辑记录。'],
  ['kingfisher', '发布专员', '我按文档的首次发布时间逐一复查。'],
  ['owl', '可观测性专员', '我把当前指标与上一轮采样对齐后再做对比。'],
  ['beaver', '运维专员', '我把两次检查结果整理到同一张表。'],
  ['beaver', '复查专员', '我会核对汇总使用的时间范围。'],
] as const;

function Preview() {
  const [sequence,setSequence] = useState(0);
  const [delivery,setDelivery] = useState(0);
  const [waiting,setWaiting] = useState(false);
  return <main style={{maxWidth:680,margin:'24px auto',padding:'0 14px'}}>
    <div style={{display:'flex',flexWrap:'wrap',gap:10,marginBottom:20}}>
      <button className="button secondary" type="button" onClick={()=>setSequence(n=>n+1)}>继续追加</button>
      <button className="button secondary" type="button" onClick={()=>setDelivery(1)}>第一位交稿</button>
      <button className="button secondary" type="button" onClick={()=>setDelivery(participants.length)}>全部交稿</button>
      <button className="button secondary" type="button" onClick={()=>setWaiting(value=>!value)}>切换等待</button>
    </div>
    <div className="ai-transcript" data-transcript-mode="conversation"><div className="ai-turn">
      <div className="pilot-specialist-conversation">{participants.map(([avatarId,name,progress], index) => {
        const sessionId = `demo-session-${index}`, roleId = `demo-role-${index}`, workerId = `demo-worker-${index}`;
        const rootTurnId = `demo-root-${index}`, taskId = `demo-task-${index}`;
        const author = {kind:'specialist' as const,name,roleId,avatarId,sessionId,workerId,taskId,rootTurnId};
        const task = {taskId,sessionId,projectId:'demo',title:'核对公开记录',state:'running',acceptanceState:'not_evaluated',revision:1,originRootTurnId:rootTurnId,deadlineAt:at} as const;
        const activity = {phase:waiting?'waiting_approval':'tool',label:waiting?'等待确认':'正在核对',updatedAt:at} as const;
        const finalReport: Message | undefined = index < delivery ? {id:`demo-result-${index}`,sessionId:'demo-pilot',role:'assistant',text:'已核对记录并提交结论。',createdAt:at,author} : undefined;
        const row: PilotSpecialistRow = {projectId:'demo',sourceMessageId:'demo-input',sourceCreatedAt:at,reportedTurns:[],worker:{id:workerId,roleId,roleName:name,sessionId,assignmentState:'active',task},activity,author,finalReport};
        const content = progress+(sequence?' 继续核对本轮记录。'.repeat(sequence):'');
        const snapshot = {session:{id:sessionId,projectId:'demo'},superagent:{roleId,task},cursor:sequence,messages:[],resources:[],
          ai:{session:sessionId,status:waiting?'waiting_approval':'running',replyStatus:waiting?'waiting_approval':'running',rootTurnId,turnStartedAt:at,cards:[{id:`demo-card-${index}`,type:'message',status:'running',at,content,data:{root_turn_id:rootTurnId}}],cardsOffset:0,totalCards:1}} as SessionSnapshot;
        return <PilotSpecialistReplyView key={workerId} row={row} snapshot={snapshot} livePacket={sequence>0}/>;
      })}</div>
    </div></div>
  </main>;
}

createRoot(document.getElementById('root')!).render(params.has('catalog')
  ? <main>{lakeAvatarCatalog.map(({id,name}) => <div key={id} title={name}>{name}<SpecialistReplyCursor avatar={id}/></div>)}</main>
  : <Preview/>);
