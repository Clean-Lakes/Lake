// Fictional SSH execution. No backend, model, credentials or remote commands.
import {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {SessionSnapshot, TerminalEntry, TerminalHistory, TerminalSession} from '../../../shared/contracts';
import {SSHExecutionGlow, SSHExecutionPanel} from '../../src/SSHExecutionPanel';
import {TerminalSidePanel} from '../../src/TerminalSidePanel';
import {useSSHExecution} from '../../src/useSSHExecution';
import {executionIsActive} from '../../src/sshExecution';
import '../../src/styles.css';
import '../../src/theme.css';

const start = new Date().toISOString();
const term = {id:'demo-ssh',sessionId:'demo',resourceId:'demo-host',generation:'demo-g1',holder:'agent',status:'busy',createdAt:start} as TerminalSession;
let entries: TerminalEntry[] = [], fail = false, delay = false, reads = 0, writes = 0;
const requestProof = document.createElement('output'); requestProof.id='ssh-request-proof';requestProof.hidden=true;document.body.appendChild(requestProof);
window.fetch = async(input, init) => {
  const url = String(input);
  if (init?.method && init.method !== 'GET') writes++;
  reads++;requestProof.textContent=JSON.stringify({reads,writes});
  if (!url.endsWith('/terminals/demo-ssh/history')) throw new Error('Unexpected fixture request');
  const captured = JSON.stringify({terminal:term,entries,output:'PRIVATE_MANUAL_OUTPUT_MUST_NOT_APPEAR'} satisfies TerminalHistory);
  if (delay) await new Promise(resolve => setTimeout(resolve,1500));
  if (fail) throw new Error('Fictional transport failure');
  return new Response(captured,{headers:{'content-type':'application/json'}});
};
if(new URLSearchParams(location.search).get('theme')==='dark')document.documentElement.dataset.theme='dark';

function Fixture() {
  const [tick,setTick]=useState(0),[status,setStatus]=useState('running'),[dismissed,setDismissed]=useState(false),[session,setSession]=useState('demo');
  const [manual,setManual]=useState(false);
  useEffect(() => {
    const timer = setInterval(() => {
      if (status !== 'running') return;
      const number = Math.floor(Date.now()/1000)%100;
      if (!entries.length) entries=[{id:'demo-command',terminalId:term.id,generation:term.generation,actor:'agent',originSessionId:'demo',command:'journalctl -u demo.service --no-pager -n 80',output:'',status:'running',startedAt:start,createdAt:start,finishedAt:null,exitCode:null,cwd:'/srv/demo'}];
      const last = entries.at(-1)!;
      if (last.status === 'running') last.output+=`10:24:${String(number).padStart(2,'0')}  demo.service  request completed · status=200\r\n`;
      setTick(value=>value+1);
    },500);
    return()=>clearInterval(timer);
  },[status]);
  const resources = [{id:'demo-host',name:'演示 SSH 服务器',kind:'ssh'}] as SessionSnapshot['resources'];
  const snapshot = {session:{id:session},resources,terminals:[term],ai:{turnStartedAt:start,status}} as SessionSnapshot;
  const execution = useSSHExecution(snapshot,true,tick);
  const open = !!execution.history && !dismissed && !manual;
  const glow = open && !execution.stale && executionIsActive(execution.history,status,true);
  return <div className={`app-shell ${open||manual?'terminal-is-open':''}`}>
    <SSHExecutionGlow active={glow}/>
    <aside className="sidebar" style={{padding:24}}><strong>Lake <small>DEV · 效果预览</small></strong><p>实时执行终端</p><p>演示 SSH 服务器</p><small>此页只使用虚构数据</small></aside>
    <main className="workspace" style={{padding:32,overflowY:'auto'}}><h2>检查服务运行状态</h2><p>正在读取服务日志，确认请求是否正常。</p><p>右侧展开真实终端组件，蓝色流光覆盖整个窗口边缘。</p>
      <nav aria-label="试用控制" style={{display:'flex',gap:12,flexWrap:'wrap'}}>
        <button onClick={()=>{setDismissed(false);setManual(false);}}>展开执行终端</button>
        <button onClick={()=>{const last=entries.at(-1);if(last){last.status='completed';last.exitCode=0;}entries.push({id:'demo-next-'+entries.length,terminalId:term.id,generation:term.generation,actor:'agent',originSessionId:'demo',command:'df -h /srv/demo',output:'Filesystem       Size  Used Avail Use% Mounted on\r\n/dev/demo         80G   24G   56G  30% /srv/demo\r\n',status:'running',startedAt:new Date().toISOString(),createdAt:new Date().toISOString(),finishedAt:null,exitCode:null,cwd:'/srv/demo'});setTick(value=>value+1);}}>执行下一条命令</button>
        <button onClick={()=>setStatus('waiting_approval')}>等待确认</button>
        <button onClick={()=>{term.status='busy';setStatus('running');}}>继续执行</button>
        <button onClick={()=>{entries.forEach(entry=>{entry.status='completed';entry.exitCode=0;});term.status='ready';setStatus('completed');setTick(value=>value+1);}}>完成任务</button>
        <button onClick={()=>{fail=!fail;setTick(value=>value+1);}}>切换断线</button>
        <button onClick={()=>{delay=!delay;setTick(value=>value+1);}}>切换延迟响应</button>
        <button onClick={()=>{setSession(value=>value==='demo'?'another-session':'demo');}}>切换会话</button>
        <button onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>切换主题</button>
        <button onClick={()=>setManual(value=>!value)}>手动终端</button>
      </nav>
      <label style={{display:'block',marginTop:40}}>草稿<textarea placeholder="终端自动展开时，可以继续在这里输入" style={{display:'block',width:'100%',marginTop:12}}/></label>
    </main>
    <TerminalSidePanel open={open||manual} onClose={()=>{setDismissed(true);setManual(false);}}>{manual?<section className="terminal-panel-content"><header className="terminal-panel-header"><strong>手动终端保留</strong></header><p>自动执行不会创建或接管此终端。</p></section>:open&&<SSHExecutionPanel histories={execution.histories} resources={resources} status={status} stale={execution.stale} onClose={()=>setDismissed(true)}/>}</TerminalSidePanel>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
