// Real composer controls, in-memory responses only. No backend or model calls.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ComposerModelSelect} from '../../src/ComposerModelSelect';
import type {AvailableModelEntry,ReasoningSettings} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/appSelect.css';
import '../../src/providerIcon.css';
import '../../src/composerModelSelect.css';
const params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.has('dark')?'dark':'light';
const models:AvailableModelEntry[]=['deepseek-v4-pro','deepseek-flash','no-reasoning'].map((name,i)=>({providerId:'demo',providerName:'DeepSeek · Lake',modelId:name,name,displayName:i===2?'轻量模型':name}));
if(params.has('long'))for(let i=0;i<20;i++)models.push({...models[0]!,modelId:`demo-${i}`,name:`demo-${i}`,displayName:`演示模型 ${i+1}`,providerId:i<10?'demo':'other',providerName:i<10?'DeepSeek · Lake':'备用供应商'});
const saved:Record<string,string>={};
const calls:{modelId:string;effort:string}[]=[];
let fail=params.has('error');
const proof=document.createElement('output');proof.id='reasoning-save-proof';proof.hidden=true;proof.textContent='[]';document.body.appendChild(proof);
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 if(!url.pathname.endsWith('/ai/reasoning'))return new Response('{}',{status:404});
 if(fail){fail=false;return new Response(JSON.stringify({error:'演示读取失败'}),{status:503,headers:{'Content-Type':'application/json'}});}
 const payload=init?.method==='POST'?JSON.parse(String(init.body)):null;
 if(payload){calls.push(payload);saved[payload.modelId]=payload.effort;proof.textContent=JSON.stringify(calls);}
 const modelId=payload?.modelId||currentModel;
 const settings:ReasoningSettings={modelId,levels:modelId==='no-reasoning'?[]:modelId==='deepseek-v4-pro'?['low','high']:['none','low','medium','high','max'],default:'high',effort:saved[modelId]??''};
 return new Response(JSON.stringify(settings),{headers:{'Content-Type':'application/json'}});
};
let currentModel='deepseek-flash';
function Preview(){
 const [model,setModel]=useState(models[1]!),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[running,setRunning]=useState(false),[theme,setTheme]=useState(params.has('dark'));
 return <main style={{minHeight:'100vh',padding:24,boxSizing:'border-box',display:'flex',flexDirection:'column',justifyContent:'space-between'}}>
  <div><h2 style={{fontWeight:500}}>模型与思考强度</h2><p style={{color:'var(--text-secondary)'}}>共用一个轻量弹层，档位来自当前模型。</p><button className="button secondary" onClick={()=>{setTheme(!theme);document.documentElement.dataset.theme=theme?'light':'dark';}}>切换主题</button> <button className="button secondary" onClick={()=>setRunning(!running)}>{running?'结束运行':'模拟运行中'}</button></div>
  <div style={{marginBottom:30,alignSelf:'flex-end',width:'min(640px,100%)'}}><div style={{border:'1px solid var(--border)',borderRadius:'var(--radius-window)',background:'var(--surface)',padding:'16px 18px',color:'var(--text-muted)'}}>想让 Lake 帮你做什么？</div><div style={{display:'flex',justifyContent:'flex-end',paddingTop:8}}><ComposerModelSelect configured available={{models:models.map(m=>m.name),entries:models,loading:false,imageInputCapabilities:{'deepseek-flash':true}}} modelName={model.name} selection={model} open={open} disabled={busy} onOpenChange={setOpen} onSettings={()=>{setOpen(false);alert('演示模型设置入口');}} onSelect={entry=>{if(typeof entry!=='string'){currentModel=entry.modelId;setModel(entry);setOpen(false);}}} reasoning={{session:"demo",modelId:model.modelId,disabled:running,disabledReason:"本轮运行中，结束后可调整思考强度。",onSaving:setBusy}}/></div></div>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
