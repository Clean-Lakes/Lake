// Isolated queue operations, revision checks and edits stay in memory. No model or backend.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PendingMessages} from '../../src/PendingMessages';
import {Glyph} from '../../src/Icons';
import {setThemePreference} from '../../src/appearance';
import type {MessageQueue,QueueOperation} from '../../../shared/contracts';
import '../../src/styles.css';
const params=new URLSearchParams(location.search);
setThemePreference(params.get('theme')==='dark'?'dark':'light');
const at='2026-10-18T12:00:00Z';
let queue:MessageQueue={paused:params.has('paused'),revision:1,lastError:'',items:Array.from({length:params.has('many')?3:1},(_,i)=>({id:`pending-${i}`,text:['对比前后两次采样，确认负载变化。','再检查容器状态，并保留原始结果。','汇总检查结果，说明尚未确认的事项。'][i]!,resourceIds:['fixture-host'],references:[],images:[],files:params.has('files')&&i===0?[{sourceId:'fixture-file',name:'排查记录与历史采样.txt',sizeBytes:1024}]:[],createdAt:at}))};
let latest:QueueOperation|null=null;
const previous=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 if(url.pathname!=='/api/sessions/fixture/message-queue')return previous(input,init);
 const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 if((init?.method??'GET')==='GET')return json(queue);
 if(params.has('error'))return json({error:'队列暂时无法保存，请重试。'},503);
 const data=JSON.parse(String(init?.body)) as QueueOperation;
 if(data.revision!==queue.revision)return json({error:'队列已更新'},409);
 latest=data;
 let items=queue.items;
 if(data.operation==='remove')items=items.filter(item=>item.id!==data.id);
 if(data.operation==='edit')items=items.map(item=>item.id===data.id?{...item,text:data.text,resourceIds:data.resourceIds,references:data.references}:item);
 if(data.operation==='reorder')items=data.ids.map(id=>items.find(item=>item.id===id)!);
 queue={...queue,items,paused:data.operation==='pause'?true:data.operation==='resume'?false:queue.paused,revision:queue.revision+1};
 return json(queue);
};
function Fixture(){
 const [value,setValue]=useState(queue);
 return <main style={{height:'100dvh',padding:24,display:'flex',flexDirection:'column',justifyContent:'space-between'}}>
  <div><h2>Lake · 接下来</h2><p>隔离交互验证，所有队列操作只保存在内存。</p><button type="button" onClick={()=>{queue={...queue,revision:queue.revision+1,items:[...queue.items,{id:`added-${queue.revision}`,text:'补充检查磁盘剩余空间。',resourceIds:[],images:[],files:[],createdAt:at}]};setValue(queue);}}>模拟新消息</button><output aria-label="最近队列操作" style={{display:'block',fontSize:10,marginTop:8}}>{latest?JSON.stringify(latest):'无'}</output></div>
  <div style={{width:'100%',maxWidth:960,margin:'0 auto'}}>
   <PendingMessages sessionId="fixture" queue={value} disabled={params.has('disabled')} active sendShortcut="enter" resourceIds={()=>['fixture-host']} onUpdated={setValue}/>
   <div className="composer"><div className="composer-input"><div className="composer-body"><textarea aria-label="给 Lake 的消息" placeholder="继续输入，稍后发送…" rows={1}/><button className="send-button stop-button" aria-label="停止本轮" disabled><Glyph name="stop" size={15}/></button></div></div>
   <div className="composer-foot" style={{justifyContent:'flex-start'}}><button type="button" className="composer-permission-button">权限</button><span style={{fontSize:11,color:'var(--text-muted)'}}>SRE 协作</span></div></div>
  </div>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
