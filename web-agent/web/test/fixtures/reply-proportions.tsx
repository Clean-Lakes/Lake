// Isolated visual replay of real transcript components. No backend or model.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import type {SessionSnapshot} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/assistantProse.css';
import '../../src/conversationBubbles.css';
import '../../src/conversationDirectory.css';
import '../../src/sreCollaboration.css';
import '../../src/pilotWorkspace.css';

const at=(n:number)=>`2026-11-05T01:00:0${n}Z`;
window.fetch=async()=>new Response('{}',{headers:{'Content-Type':'application/json'}});
function Fixture(){
 const [dark,setDark]=useState(false),[narrow,setNarrow]=useState(false),[running,setRunning]=useState(false),[tool,setTool]=useState(false),[worker,setWorker]=useState(false);
 const snapshot={session:{id:'visual',workspaceRole:worker?'worker':'pilot'},resources:[],actions:[],specialists:[],evidence:[],messages:[{id:'question',role:'user',sessionId:'visual',text:'运维组多少文档呢',createdAt:at(0)}],ai:{session:'visual',status:running?'running':'completed',rootTurnId:'turn',cardsOffset:0,cards:[{id:'intro',type:'message',status:'completed',at:at(1),content:'我查一下知识库专员的统计结果。'},...(tool?[{id:'tool',type:'operation',status:'completed',title:'list_assets',at:at(2),data:{arguments:{}}}]:[]),{id:'answer',type:'message',status:running?'running':'completed',at:at(3),content:'知识库专员上次查询结果：“南京-运维组”共有 62 个已发布文档。\n\n包含父文档和子文档，不含草稿与归档文档。'}]}} as SessionSnapshot;
 return <main style={{height:'100%',overflow:'auto',padding:24}}>
  <nav style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:36}}>
   <button onClick={()=>{setDark(!dark);document.documentElement.dataset.theme=dark?'light':'dark'}}>切换主题</button>
   <button onClick={()=>setNarrow(!narrow)}>切换窄屏</button>
   <button onClick={()=>setRunning(!running)}>切换流式</button>
   <button onClick={()=>setTool(!tool)}>切换工具边界</button>
   <button onClick={()=>setWorker(!worker)}>切换专员频道</button>
  </nav>
  <section style={{width:narrow?320:960,maxWidth:'100%',margin:'0 auto'}}>
   <AITranscript snapshot={snapshot} assistantIdentity={worker?{name:'知识库专员'}:{name:'Pilot',pilot:true}}/>
  </section>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
