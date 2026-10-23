// Synthetic conversation replay: no backend, model or real resource operations.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import type {Resource,SessionSnapshot} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/assistantProse.css';
import '../../src/conversationDirectory.css';
import '../../src/statusText.css';
const at=new Date(Date.now()-30000).toISOString();
const resources=(['local','ssh','database','redis','docker','kubernetes','apisix','prometheus','victoriametrics'] as const).map((kind,i)=>({id:`resource-${i}`,projectId:'fixture',kind,name:`测试${kind}`,description:'',status:'available'} satisfies Resource));
const prose='已确认源端到目标端无免密通道，计划改走临时 HTTP 传输；当前仍在源端检查业务写入并导出数据库，迁移未完成，传输通道可用性尚未验证。';
function Fixture(){
 const [text,setText]=useState(prose),[running,setRunning]=useState(true),[width,setWidth]=useState(800),[plain,setPlain]=useState(false);
 window.fetch=async()=>new Response(JSON.stringify({text,pending:false}),{headers:{'Content-Type':'application/json'}});
 const snapshot={session:{id:'fixture',projectId:'fixture'},messages:[{id:'user',role:'user',text:'检查资源状态',createdAt:at}],actions:[],resources,ai:{session:'fixture',status:running?'running':'completed',rootTurnId:'turn',turnStartedAt:at,cardsOffset:0,cards:[...(plain?[]:[{id:'catalog',type:'operation',title:'list_assets',status:'completed',at,data:{target:'项目资源目录',arguments:{pattern:'测试'}}},...resources.map((resource,i)=>({id:`operation-${i}`,type:'operation',title:'shell',status:'completed',at,data:{resource_id:resource.id,target:resource.name,arguments:{}}}))]),{id:'reply',type:'message',status:running?'running':'completed',content:text,at}]}} as SessionSnapshot;
 return <main className="workspace" style={{height:'100%'}}>
<nav style={{display:'flex',gap:12,flexWrap:'wrap',marginBottom:24}}><button onClick={()=>setWidth(width===800?310:800)}>切换宽度</button><button onClick={()=>document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'}>切换主题</button><button onClick={()=>setText(value=>value+prose)}>追加正文</button><button onClick={()=>setRunning(value=>!value)}>切换运行</button><button onClick={()=>setPlain(value=>!value)}>切换普通回复</button></nav><section className="session-view"><section className="conversation" style={{width,maxWidth:'100%'}}><div className="timeline-list"><AITranscript snapshot={snapshot}/></div></section></section></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
