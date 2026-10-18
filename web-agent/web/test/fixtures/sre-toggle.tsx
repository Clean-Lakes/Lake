// Delayed, synthetic settings requests. Never calls a backend, model or host.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SREModeToggle} from '../../src/SREModeToggle';
import type {SessionSnapshot} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/sreCollaboration.css';
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light';
let count=0,serverEnabled=false,waiting:{enabled:boolean;resolve:(response:Response)=>void}|null=null;
let update=()=>{};
window.fetch=async(input,init)=>{
 if(String(input)!=='/api/projects/fixture/sre'||init?.method!=='PUT')return new Response('{}',{status:403});
 count++;const enabled=JSON.parse(String(init.body)).enabled as boolean;
 return new Promise<Response>(resolve=>{waiting={enabled,resolve};update()});
};
function Fixture(){
 const [enabled,setEnabled]=useState(false),[blocked,setBlocked]=useState(false),[,render]=useState(0);
 update=()=>render(n=>n+1);
 const finish=(ok:boolean)=>{if(!waiting)return;const pending=waiting;waiting=null;if(ok)serverEnabled=pending.enabled;pending.resolve(new Response(JSON.stringify(ok?{enabled:serverEnabled}:{error:'模拟保存失败，请重试。'}),{status:ok?200:503,headers:{'Content-Type':'application/json'}}));update()};
 const snapshot={session:{id:'fixture',projectId:'fixture'},ai:{profile:'core'},sre:{enabled}} as SessionSnapshot;
 return <main style={{maxWidth:680,margin:'40px auto',padding:20}}><h2>SRE 开关 · 隔离验收</h2><p>保存请求保持等待，可检查光标、焦点、外观与重复提交。</p><div className="composer-foot" style={{minHeight:44,margin:'24px 0'}}><span>权限</span><SREModeToggle snapshot={snapshot} disabled={blocked} disabledReason="本轮运行中，结束后可切换 SRE 协作。" onUpdated={async()=>setEnabled(serverEnabled)}/></div><div style={{display:'flex',gap:10,flexWrap:'wrap'}}><button onClick={()=>finish(true)}>完成保存</button><button onClick={()=>finish(false)}>模拟保存失败</button><button onClick={()=>setBlocked(value=>!value)}>切换运行中状态</button></div><output aria-label="请求统计" style={{display:'block',marginTop:20,overflowWrap:'anywhere',fontSize:12}}>{JSON.stringify({requests:count,pending:!!waiting,enabled,blocked})}</output></main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture/></React.StrictMode>);
