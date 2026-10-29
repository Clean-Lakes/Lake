// Isolated queue UI. No model, terminal, release or resource API is called.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {MessageQueue} from '../../../shared/contracts';
import {PendingMessages} from '../../src/PendingMessages';
import '../../src/styles.css';
const dark=new URLSearchParams(location.search).get('theme')==='dark';document.documentElement.dataset.theme=dark?'dark':'light';
const initial:MessageQueue={paused:false,revision:3,lastError:'',items:['先核对发布失败的原因，不要重复部署','保留这条排队消息，稍后处理'].map((text,i)=>({id:`pending-${i}`,text,resourceIds:[],images:[],files:[],createdAt:'2026-10-29T08:00:00Z'}))};
function Fixture(){
 const [queue,setQueue]=useState(initial),[requests,setRequests]=useState(0),[received,setReceived]=useState('');
 const [active,setActive]=useState(true);
 window.fetch=async(input,init)=>{
  if(!String(input).includes('/message-queue'))throw Error('Fixture allows only queue API');
  const operation=JSON.parse(String(init?.body??'{}'));setRequests(n=>n+1);
  if(operation.operation==='push'){
   const next={...queue,revision:queue.revision+1,items:queue.items.map(item=>item.id===operation.id?{...item,supplementRootTurnId:'original-turn'}:item)};return new Response(JSON.stringify(next),{headers:{'content-type':'application/json'}});
  }
  return new Response(JSON.stringify(queue),{headers:{'content-type':'application/json'}});
 };
 return <main className="session-view" style={{maxWidth:860,margin:'60px auto',padding:20,minHeight:500,position:'relative'}}><p>当前任务正在压缩上下文…</p><output aria-label="推送请求数">推送请求：{requests}</output><button onClick={()=>{const item=queue.items.find(i=>i.supplementRootTurnId);if(item){setReceived(item.text);setQueue({...queue,revision:queue.revision+1,items:queue.items.filter(i=>i.id!==item.id)});}}}>模拟安全步骤接入</button><button onClick={()=>setActive(!active)}>{active?'模拟本轮结束':'恢复本轮'}</button>{received&&<p role="status">已补充到原任务：{received}</p>}<div style={{marginTop:150}}><PendingMessages sessionId="fixture" queue={queue} onUpdated={setQueue} disabled={false} active={active} sendShortcut="enter" resourceIds={()=>[]}/><label>当前草稿<textarea id="message-input" defaultValue="这段草稿保持不变" style={{width:'100%',minHeight:70}}/></label></div></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
