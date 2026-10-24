// Real App, synthetic API/SSE only. No model calls, credentials or SSH connections.
import './readme-workbench';
import type {SessionSnapshot, TerminalEntry, TerminalHistory, TerminalSession} from '../../../shared/contracts';

const started = new Date().toISOString(), session = 'demo-session-0';
let status = 'running', cursor = 10, denied = false, broken = false, delay = false, terminalWrites = 0;
const terminal = {id:'preview-ssh',sessionId:session,resourceId:'order-api',generation:'preview-g1',holder:'agent',status:'busy',interactive:false,createdAt:started} as TerminalSession;
const entries: TerminalEntry[] = [];
const nextCommand = () => {
  entries.forEach(entry => {entry.status='completed';entry.exitCode=0;});
  entries.push({id:`command-${entries.length}`,terminalId:terminal.id,generation:terminal.generation,actor:'agent',originSessionId:session,command:entries.length?'df -h /srv/order-api':'journalctl -u order-api --no-pager -n 80',output:entries.length?'Filesystem     Size  Used Avail Use% Mounted on\r\n/dev/demo       80G   24G   56G  30% /srv/order-api\r\n':'',status:'running',startedAt:new Date().toISOString(),createdAt:new Date().toISOString(),finishedAt:null,exitCode:null,cwd:'/srv/order-api'});
};
if (new URLSearchParams(location.search).has('finished')) {
  nextCommand();status='completed';terminal.status='ready';entries.forEach(entry=>{entry.status='completed';entry.exitCode=0;});
}
const inheritedFetch = window.fetch.bind(window);
window.fetch = async(input, init) => {
  const path = new URL(String(input),location.href).pathname;
  if ((init?.method ?? 'GET') !== 'GET' && /\/terminals(?:\/|$)/.test(path)) terminalWrites++;
  if(path.endsWith('/ai/progress-summary'))return new Response(JSON.stringify({text:'正在检查订单服务的日志与磁盘，尚待检查结果。',pending:false}),{headers:{'content-type':'application/json'}});
  if (path.endsWith('/terminals/preview-ssh/history')) {
    const captured = JSON.stringify({terminal,entries,output:'UNRELATED_MANUAL_OUTPUT'} satisfies TerminalHistory);
    if (delay) await new Promise(resolve=>setTimeout(resolve,1800));
    if (broken) throw new Error('Fictional connection interruption');
    if (denied) return new Response('{"error":"Access revoked"}',{status:403,headers:{'content-type':'application/json'}});
    return new Response(captured,{headers:{'content-type':'application/json'}});
  }
  const response = await inheritedFetch(input,init);
  if (path.endsWith('/snapshot')) {
    const value = await response.json() as SessionSnapshot;
    const requestedSession=path.match(/\/sessions\/([^/]+)\/snapshot/)?.[1];
    if(requestedSession&&requestedSession!==session){value.session={...value.session,id:requestedSession,title:'网关延迟排查',status:'completed'};value.messages=[];value.terminals=[];value.ai={...value.ai!,session:requestedSession,status:'completed',cards:[]};return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});}
    value.cursor=cursor;
    value.session.status=status==='running'?'investigating':status==='waiting_approval'?'waiting_approval':'completed';
    value.messages=[{id:'ssh-preview-question',sessionId:session,role:'user',text:'检查订单服务的日志和磁盘使用情况。',createdAt:started}];
    value.sre={enabled:false,tasks:[]};value.terminals=[terminal];
    value.replyTimings=[{messageId:'ssh-preview-question',startedAt:started,finishedAt:status==='completed'?new Date().toISOString():'',status:status==='completed'?'completed':'running'}];
    value.ai={...value.ai!,status,rootTurnId:'ssh-preview-turn',turnStartedAt:started,agentRuns:[],cards:entries.map(entry=>({id:entry.id,type:'operation',title:'shell',status:entry.status,at:entry.startedAt!,data:{resource_id:'order-api',target:'订单服务 · order-api',arguments:{command:entry.command}},content:entry.status==='completed'?entry.output:undefined}))};
    value.ai.totalCards=value.ai.cards.length;
    return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  }
  return response;
};
const streams = new Set<EventSource>();
const OriginalStream = window.EventSource;
window.EventSource = class extends OriginalStream {
  constructor(url: string | URL, options?: EventSourceInit) {super(url,options);streams.add(this);}
  close(){streams.delete(this);super.close();}
} as typeof EventSource;
const notify = () => {
  cursor++;
  const event = new MessageEvent('terminal',{data:JSON.stringify({sessionId:session,seq:cursor,type:'terminal'})});
  streams.forEach(stream=>stream.dispatchEvent(event));
};
const controls = document.createElement('nav'); controls.ariaLabel='SSH 试用控制';
Object.assign(controls.style,{position:'fixed',bottom:'92px',left:'16px',zIndex:'100',display:'flex',flexDirection:'column',gap:'5px',maxWidth:'230px'});
for (const [label, action] of [
  ['开始演示',()=>{nextCommand();notify();}],
  ['下一条命令',()=>{nextCommand();notify();}],
  ['等待确认',()=>{status='waiting_approval';notify();}],
  ['继续执行',()=>{status='running';terminal.status='busy';notify();}],
  ['完成任务',()=>{status='completed';terminal.status='ready';entries.forEach(entry=>{entry.status='completed';entry.exitCode=0;});notify();}],
  ['切换断线',()=>{broken=!broken;notify();}],
  ['切换访问权限',()=>{denied=!denied;notify();}],
  ['切换延迟响应',()=>{delay=!delay;notify();}],
] as const) {
  const button=document.createElement('button');button.textContent=label;button.onclick=action;
  Object.assign(button.style,{border:'1px solid var(--border)',borderRadius:'10px',padding:'6px 10px',background:'var(--surface)',color:'var(--foreground)',font:'inherit',textAlign:'left'});
  controls.appendChild(button);
}
const note=document.createElement('small');note.textContent='虚构数据 · 不连接服务器';controls.prepend(note);document.body.appendChild(controls);
const proof=document.createElement('output');proof.id='ssh-workbench-proof';proof.hidden=true;document.body.appendChild(proof);
let line=0;
setInterval(()=>{
  if(status==='running'&&entries.at(-1)?.status==='running') {
    entries.at(-1)!.output+=`10:24:${String(line++%60).padStart(2,'0')}  order-api  GET /health 200 OK\r\n`;
    notify();
  }
  proof.textContent=JSON.stringify({entries:entries.length,terminalWrites,cursor});
},650);
