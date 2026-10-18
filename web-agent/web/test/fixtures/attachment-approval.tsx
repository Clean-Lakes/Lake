// Synthetic approval UI only. Decisions are captured in memory, never dispatched.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AIPending} from '../../src/AIPanel';
import type {AIView} from '../../../shared/contracts';
import '../../src/theme.css';
import '../../src/styles.css';
import '../../src/sreCollaboration.css';
const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.get('theme')==='dark'?'dark':'light';
const file={sourceId:'file-synthetic-upload',name:'系统信息.xlsx',sizeBytes:12066};
const view={status:'waiting_approval',pending:{id:'synthetic-approval',kind:'file_write',risk:'write',target:'京东云服务器 · 36.151.150.63',resourceId:'synthetic-resource',fingerprint:'synthetic',...(params.has('confirm')?{confirmation:'执行 测试服务器'}:{}),call:{id:'synthetic-call',name:'stage_attachment',arguments:JSON.stringify({source_id:file.sourceId,asset_ref:'synthetic-asset',runtime:'ssh',path:'/root/系统信息.xlsx',...(params.has('overwrite')?{overwrite:true}:{})})}}} as AIView;
const originalFetch=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 if(url.pathname.startsWith('/api/')) {
  if(url.pathname.startsWith('/api/sessions/upload-ui/ai/')) {
   window.dispatchEvent(new CustomEvent('fixture-decision',{detail:{path:url.pathname,...JSON.parse(String(init?.body))}}));
   return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});
  }
  return new Response('{}',{status:403,headers:{'Content-Type':'application/json'}});
 }
 return originalFetch(input,init);
};
function Fixture(){
 const [decision,setDecision]=useState('');
 React.useEffect(()=>{const handle=(event:Event)=>setDecision(JSON.stringify((event as CustomEvent).detail));window.addEventListener('fixture-decision',handle);return()=>window.removeEventListener('fixture-decision',handle)},[]);
 return <main style={{maxWidth:700,padding:20,margin:'40px auto'}}><p style={{fontSize:12,color:'var(--text-muted)',marginBottom:18}}>附件上传确认 · 隔离界面验收</p><AIPending session="upload-ui" attachments={[file]} view={view} {...(params.has('child')?{runId:'synthetic-child',agentName:'调查员'}:{})} refresh={async()=>{}}/>{decision&&<output aria-label="测试决策记录" style={{display:'block',overflowWrap:'anywhere',fontSize:12}}>{decision}</output>}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
