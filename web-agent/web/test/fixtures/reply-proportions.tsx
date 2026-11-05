// Isolated visual replay of real transcript components. No backend or model.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AIPending,AITranscript} from '../../src/AIPanel';
import type {AIView,SessionSnapshot} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/assistantProse.css';
import '../../src/conversationBubbles.css';
import '../../src/conversationDirectory.css';
import '../../src/sreCollaboration.css';
import '../../src/pilotWorkspace.css';
import '../../src/objectReferences.css';

const at=(n:number)=>`2026-11-05T01:00:0${n}Z`;
const query=new URLSearchParams(location.search);
document.documentElement.dataset.theme=query.has('dark')?'dark':'light';
const richReply='演示服务器的检查结果已收到。\n\n> 这段引用、表格和代码仅用于验证阅读布局，不会访问服务器。\n\n| 资源 | 服务 | 内存使用率 | 磁盘使用率 | 检查来源 |\n| --- | --- | --- | --- | --- |\n| 演示服务器 | example-service | 36% | 21% | `/var/log/example/current.log` |\n\n```sh\nprintf "%s\\n" "这是一条很长的演示命令，代码需要在自己的区域横向滚动，不能撑宽整个会话阅读列。'+ '演示内容'.repeat(24)+'"\n```\n\n检查结果保持原始段落顺序，审批仍是独立控件。';
const pending={pending:{id:'approval-visual',kind:'resource_select',risk:'readonly',target:'演示服务器',resourceId:'server-visual',fingerprint:'fixture',needsTerminal:true,call:{id:'approval-call',name:'inspect_host',arguments:'{"asset_ref":"server-visual"}'}}} as AIView;
window.fetch=async()=>new Response('{}',{headers:{'Content-Type':'application/json'}});
function Fixture(){
 const [dark,setDark]=useState(query.has('dark')),[narrow,setNarrow]=useState(query.has('narrow')),[running,setRunning]=useState(false),[tool,setTool]=useState(false),[worker,setWorker]=useState(false),[rich,setRich]=useState(query.has('rich')),[approval,setApproval]=useState(query.has('approval'));
 const snapshot={session:{id:'visual',workspaceRole:worker?'worker':'pilot'},resources:[{id:'server-visual',kind:'ssh',name:'演示服务器',ssh:{host:'192.0.2.34',port:22,username:'fixture'}}],actions:[],specialists:[],evidence:[],messages:[{id:'question',role:'user',sessionId:'visual',text:rich?'分析演示服务器':'运维组多少文档呢',createdAt:at(0)}],ai:{session:'visual',status:running?'running':'completed',rootTurnId:'turn',cardsOffset:0,cards:[{id:'intro',type:'message',status:'completed',at:at(1),content:'我查一下现有记录。'},...(tool?[{id:'tool',type:'operation',status:'completed',title:'list_assets',at:at(2),data:{arguments:{}}}]:[]),{id:'answer',type:'message',status:running?'running':'completed',at:at(3),content:rich?richReply:'知识库专员上次查询结果：“南京-运维组”共有 62 个已发布文档。\n\n包含父文档和子文档，不含草稿与归档文档。'}]}} as SessionSnapshot;
 return <main style={{height:'100%',overflow:'auto',padding:24}}>
  <nav style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:36}}>
   <button onClick={()=>{setDark(!dark);document.documentElement.dataset.theme=dark?'light':'dark'}}>切换主题</button>
   <button onClick={()=>setNarrow(!narrow)}>切换窄屏</button>
   <button onClick={()=>setRunning(!running)}>切换流式</button>
   <button onClick={()=>setTool(!tool)}>切换工具边界</button>
   <button onClick={()=>setWorker(!worker)}>切换专员频道</button>
   <button onClick={()=>setRich(!rich)}>切换代码与表格</button>
   <button onClick={()=>setApproval(!approval)}>切换审批控件</button>
  </nav>
  <section style={{width:narrow?320:960,maxWidth:'100%',margin:'0 auto'}}>
   <AITranscript snapshot={snapshot} assistantIdentity={worker?{name:'知识库专员'}:{name:'Pilot',pilot:true}}/>
   {approval&&<div className="ai-transcript"><AIPending session="visual" view={pending} refresh={async()=>{setApproval(false)}}/></div>}
  </section>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
