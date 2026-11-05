import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import type {AICard,SessionSnapshot} from '../../../shared/contracts';
import '../../src/sessionPresentation.css';
import '../../src/conversationDirectory.css';
import '../../src/styles.css';
import '../../src/pilotWorkspace.css';
import '../../src/sreCollaboration.css';
import '../../src/assistantProse.css';
import '../../src/conversationBubbles.css';

const stages=['发送瞬间','整理上下文','空文本占位','模型思考','工具间进度','正文流式','完成'] as const;
function Preview(){
 const [stage,setStage]=useState(0),[playing,setPlaying]=useState(false),[pilot,setPilot]=useState(false);
 const [startedAt,setStartedAt]=useState(()=>new Date().toISOString());
 const ended=stage===stages.length-1;
 useEffect(()=>{if(!playing)return;const timer=setInterval(()=>setStage(s=>Math.min(s+1,stages.length-1)),700);return()=>clearInterval(timer);},[playing]);
 useEffect(()=>{if(ended)setPlaying(false);},[ended]);
 const cards:AICard[]=stage===0?[]:stage===1?[{id:'compact',at:startedAt,type:'compaction',status:'running',content:'正在压缩上下文…'}]:stage===2?[{id:'reply',at:startedAt,type:'message',status:'running',content:''}]:stage===3?[{id:'reasoning',at:startedAt,type:'thinking',status:'running',content:''}]:stage===4?[{id:'note',at:startedAt,type:'message',status:'completed',content:'我先查看现有任务记录，确认你刚才问的“为什么”所对应的上下文。'},{id:'search',at:new Date(Date.parse(startedAt)+1).toISOString(),type:'operation',title:'search_super_tasks',status:'completed',content:'synthetic fixture result'},{id:'next-thought',at:new Date(Date.parse(startedAt)+2).toISOString(),type:'thinking',status:'running',content:''}]:[{id:'reply',at:startedAt,type:'message',status:ended?'completed':'running',content:'这是实际正文，开始输出后不再显示三点等待气泡。'}];
 const snapshot={session:{id:'thinking-fixture',workspaceRole:pilot?'router':'worker'},messages:[{id:'user',sessionId:'thinking-fixture',role:'user',text:'继续看看',createdAt:startedAt}],resources:[],actions:[],replyTimings:pilot?[{messageId:'user',startedAt,status:ended?'completed':'running',finishedAt:ended?new Date().toISOString():''}]:[],ai:{session:'thinking-fixture',status:ended?'completed':pilot&&stage===0?'idle':'running',turnStartedAt:startedAt,cards,cardsOffset:0}} as SessionSnapshot;
 return <main style={{maxWidth:860,margin:'32px auto',padding:'0 24px'}}>
  <header style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:32}}>
   <button onClick={()=>setPilot(p=>!p)}>{pilot?'Pilot':'服务器专员'}</button>
   <button onClick={()=>{setStartedAt(new Date().toISOString());setStage(0);setPlaying(true);}}>连续播放</button>
   <button onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>切换主题</button>
   {stages.map((label,index)=><button key={label} aria-pressed={stage===index} onClick={()=>{setPlaying(false);setStage(index);}}>{label}</button>)}
  </header>
  <p role="status" data-preview-stage={stage}>状态预览：{stages[stage]}</p>
  <AITranscript snapshot={snapshot} assistantIdentity={pilot?{name:'Pilot',pilot:true}:{name:'服务器运维排查专员'}}/>
 </main>;
}
document.documentElement.dataset.theme='light';
createRoot(document.getElementById('root')!).render(<Preview/>);
