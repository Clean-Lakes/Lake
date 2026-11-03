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

const stages=['发送瞬间','空文本占位','模型思考','正文流式','完成'] as const;
function Preview(){
 const [stage,setStage]=useState(0),[playing,setPlaying]=useState(false),[pilot,setPilot]=useState(false);
 const [startedAt,setStartedAt]=useState(()=>new Date().toISOString());
 useEffect(()=>{if(!playing)return;const timer=setInterval(()=>setStage(s=>Math.min(s+1,4)),700);return()=>clearInterval(timer);},[playing]);
 useEffect(()=>{if(stage===4)setPlaying(false);},[stage]);
 const cards:AICard[]=stage===0?[]:stage===1?[{id:'reply',at:startedAt,type:'message',status:'running',content:''}]:stage===2?[{id:'reasoning',at:startedAt,type:'thinking',status:'running',content:''}]:[{id:'reply',at:startedAt,type:'message',status:stage===4?'completed':'running',content:'这是实际正文，开始输出后不再显示三点等待气泡。'}];
 const snapshot={session:{id:'thinking-fixture'},messages:[{id:'user',sessionId:'thinking-fixture',role:'user',text:'继续看看',createdAt:startedAt}],resources:[],actions:[],replyTimings:[{messageId:'user',startedAt,status:stage===4?'completed':'running',finishedAt:stage===4?new Date().toISOString():''}],ai:{session:'thinking-fixture',status:stage===0?'idle':stage===4?'completed':'running',turnStartedAt:startedAt,cards,cardsOffset:0}} as SessionSnapshot;
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
