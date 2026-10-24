// Actual conversation components, fictional API only. Never contacts a model or host.
import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import type {AICard,CommandStopNotice,Resource,SessionSnapshot,TerminalEntry,TerminalHistory,TerminalSession} from '../../../shared/contracts';
import '../../src/theme.css';
import '../../src/styles.css';
import '../../src/assistantProse.css';

const params=new URLSearchParams(location.search);
if(params.get('theme')==='dark')document.documentElement.dataset.theme='dark';
let session='mini-box',status='running',revision=1,broken=false,denied=false;
const started=new Date(Date.now()-10000).toISOString();
const resources=[{id:'host-a',projectId:'p',name:params.has('local')?'Local machine':'192.0.2.2',kind:params.has('local')?'local':'ssh'},{id:'host-b',projectId:'p',name:'192.0.2.3',kind:'ssh'}] as Resource[];
const terminals=resources.map((resource,i)=>({id:'terminal-'+i,sessionId:'mini-box',resourceId:resource.id,generation:'generation-'+i,status:'busy',holder:'agent',writerSessionId:'mini-box',createdAt:started})) as TerminalSession[];
const entries=terminals.map((terminal,i)=>({id:'entry-'+i,terminalId:terminal.id,generation:terminal.generation,actor:'agent',originSessionId:'mini-box',command:i?'find /srv -maxdepth 2 -type f':params.has('local')?'for i in 1 2 3 4 5; do printf "local step %s\\n" "$i"; sleep 1; done':'kubectl get pods -n demo',output:i?'/srv/app/config.yaml\r\n':params.has('local')?'local step 1\r\n':'NAME           READY   STATUS\r\ndemo-api       1/1     Running\r\n',status:'running',exitCode:null,startedAt:started,createdAt:started,finishedAt:null,cwd:'/srv'})) as TerminalEntry[];
const notices:CommandStopNotice[]=[];
const proof=document.createElement('output');proof.id='mini-box-proof';proof.hidden=true;document.body.appendChild(proof);
const requests:Array<{path:string;method:string;body?:unknown}>=[];
window.fetch=async(input,init)=>{
 const path=String(input),method=init?.method??'GET';
 if(path.endsWith('/ai/progress-summary'))return new Response(JSON.stringify({text:'正在核对两台主机的运行状态。',pending:false}));
 requests.push({path,method,body:init?.body?JSON.parse(String(init.body)):undefined});
 const index=path.includes('/terminal-1/')?1:0;
 if(path.endsWith('/history')){
  const captured=JSON.stringify({terminal:terminals[index],entries:[entries[index]],output:'PRIVATE_MANUAL_SCREEN'} as TerminalHistory);
  if(params.has('delay'))await new Promise(resolve=>setTimeout(resolve,1200));
  if(broken)throw new Error('Fixture disconnected');
  if(denied)return new Response('{"error":"fixture forbidden"}',{status:403});
  return new Response(captured,{headers:{'content-type':'application/json'}});
 }
 if(path.endsWith('/interrupt-command')){
  const body=JSON.parse(String(init?.body));
  if(body.entryId!==entries[index]!.id||body.generation!==terminals[index]!.generation)return new Response('{}',{status:409});
  const requestedAt=new Date().toISOString();
  entries[index]!.stopRequestedAt=requestedAt;entries[index]!.status='unknown';terminals[index]!.status='ready';
  notices.push({entryId:entries[index]!.id,terminalId:terminals[index]!.id,resourceId:resources[index]!.id,resourceName:resources[index]!.name,requestedAt,status:'unknown',exitCode:null,finishedAt:requestedAt});revision++;
  return new Response('{"stopRequested":true}');
 }
 return new Response('{}');
};
function Fixture(){
 const [,render]=useState(0);
 useEffect(()=>{const timer=setInterval(()=>{
  entries.forEach((entry,i)=>{if(entry.status==='running')entry.output+=i?`/srv/app/file-${revision}.txt\r\n`:params.has('local')?`local step ${revision}\r\n`:`demo-worker-${revision}  1/1  Running\r\n`;});revision++;
  proof.textContent=JSON.stringify({requests,entries,notices,status,session});render(value=>value+1);
 },400);return()=>clearInterval(timer);},[]);
 const cards=entries.map((entry,i)=>({id:'call-'+i,type:'operation',title:'shell',status:entry.stopRequestedAt?'interrupted':entry.status,at:started,data:{resource_id:resources[i]!.id,target:resources[i]!.name,arguments:{command:entry.command}}})) as AICard[];
 const snapshot={session:{id:session,projectId:'p'},resources,terminals,messages:[{id:'user',sessionId:session,role:'user',text:'检查这两台主机的运行情况。',createdAt:started}],actions:[],cursor:revision,commandStopNotices:notices,replyTimings:[{messageId:'user',startedAt:started,status:status==='running'?'running':'completed',finishedAt:status==='completed'?new Date().toISOString():''}],ai:{session,status,cards,turnStartedAt:started,cardsOffset:0,totalCards:cards.length}} as SessionSnapshot;
 return <main style={{maxWidth:1040,margin:'40px auto',padding:'0 28px'}}><nav aria-label="Mini Box 隔离验收" style={{display:'flex',flexWrap:'wrap',gap:12,marginBottom:40}}>
  <span>虚构资源 · Mini Box 验收</span>
  <button onClick={()=>{status='completed';entries.forEach((entry,i)=>{if(entry.status==='running'){entry.status='completed';entry.exitCode=0;terminals[i]!.status='ready';}});revision++;render(value=>value+1);}}>结束会话</button>
  <button onClick={()=>{broken=!broken;render(value=>value+1);}}>切换断线</button>
  <button onClick={()=>{denied=!denied;render(value=>value+1);}}>切换权限</button>
  <button onClick={()=>{session=session==='mini-box'?'other-session':'mini-box';render(value=>value+1);}}>切换会话</button>
  <button onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>切换主题</button>
 </nav><AITranscript key={session} snapshot={snapshot}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
