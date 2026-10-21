// Fictional UI-only lifecycle. No backend, model calls or real resources.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import type {AICard,Resource,SessionSnapshot} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/theme.css';
import '../../src/conversationDirectory.css';
import '../../src/assistantProse.css';
const resources=[{id:'fixture-host',name:'演示服务器',kind:'ssh'},{id:'fixture-db',name:'演示数据库',kind:'database'}] as Resource[];
const start=new Date(Date.now()-22000).toISOString();
const operation=(id:string,title:string,resource:Resource):AICard=>({id,type:'operation',title,status:'completed',at:start,data:{resource_id:resource.id,target:resource.name,arguments:{command:'fixture-command-'+id}},content:'隔离演示结果 · '+id});
function Fixture(){
 const [ended,setEnded]=useState(false),[extra,setExtra]=useState(0);
 const cards=[operation('host-check','shell',resources[0]!),operation('db-query','execute_sql',resources[1]!),operation('host-read','read',resources[0]!),...Array.from({length:extra},(_,i)=>operation('extra-'+i,'shell',resources[0]!)),{id:'reply',type:'message',status:ended?'completed':'running',at:new Date(Date.now()+1000).toISOString(),content:ended?'检查完成，两个演示资源均正常。可以通过耗时栏回看完整记录。':'正在核对演示资源。资源按首次出现顺序排列，具体操作默认折叠。'}] as AICard[];
 const snapshot={session:{id:'fixture'},resources,messages:[{id:'question',sessionId:'fixture',role:'user',text:'检查这两个演示资源的状态',createdAt:start}],actions:[],replyTimings:[{messageId:'question',startedAt:start,status:ended?'completed':'running',finishedAt:ended?new Date().toISOString():''}],ai:{session:'fixture',status:ended?'completed':'running',cardsOffset:0,cards}} as SessionSnapshot;
 return <main style={{maxWidth:880,margin:'70px auto',padding:24}}><nav aria-label="隔离验收控制" style={{display:'flex',gap:12,marginBottom:36}}><button onClick={()=>setExtra(value=>value+1)}>追加操作</button><button onClick={()=>setEnded(true)}>完成会话</button><button onClick={()=>setEnded(false)}>继续会话</button></nav><AITranscript snapshot={snapshot}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
