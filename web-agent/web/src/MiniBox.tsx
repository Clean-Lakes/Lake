import {lazy,Suspense,useState} from 'react';
import type {AICard,CommandStopNotice} from '../../shared/contracts';
import {api} from './api';
import {Glyph} from './Icons';
import {miniCanStop,miniOutput,miniRecordedOutput,miniTarget,type MiniBoxScope} from './miniBoxModel';
import {useMiniBox} from './useMiniBox';
import {MiniBoxParticles} from './MiniBoxParticles';

// Load the browser-only emulator only when a mini viewport is actually shown.
const TerminalPane=lazy(()=>import('./TerminalPane').then(module=>({default:module.TerminalPane})));

const observeOnly=()=>{};
export function MiniBox({scope,resource,kind,cards,onInspect}:{scope:MiniBoxScope;resource:string;kind:'local'|'ssh';cards:AICard[];onInspect?:()=>void}) {
  const protocol=kind==='local'?'本机':'SSH';
  const {histories,stale,refresh}=useMiniBox(scope,resource);
  const target=miniTarget(histories);
  const [open,setOpen]=useState(true),[pending,setPending]=useState(''),[error,setError]=useState('');
  const currentKey=target?`${target.history.terminal.id}:${target.entry.id}`:'';
  const stopping=!!target&&(!!target.entry.stopRequestedAt||pending===currentKey);
  const canStop=miniCanStop(target,scope,stale)&&!stopping;
  const active=canStop&&!scope.waiting;
  const last=cards.at(-1);
  const status=stale?'连接暂时中断':stopping?target?.entry.status==='running'?'正在终止…':'用户已终止 · 结果待核查'
    :active?'AI 正在执行':target?.entry.status==='running'?'命令仍在运行':target?.entry.status==='unknown'?'结果待核查'
    :target?.entry.exitCode!=null&&target.entry.exitCode!==0?'执行失败':target?'已完成'
    :last?.status==='running'?'等待命令派发':last?.status==='pending'?'等待确认':last?.status==='failed'?'执行失败':'记录输出';
  const output=target?miniOutput(target.history.entries):miniRecordedOutput(last);
  async function stop(){
    if(!canStop||!target)return;
    setPending(currentKey);setError('');onInspect?.();
    try {await api.terminalInterruptCommand(scope.session,target.history.terminal.id,target.history.terminal.generation,target.entry.id);refresh();}
    catch{setError('终止未确认，请核查当前命令状态。');setPending('');refresh();}
  }
  return <div className="mini-box-container">
    <section className={`mini-box${active?' is-operating':''}${open?'':' is-collapsed'}`} aria-label={`Mini Box ${protocol} 命令终端`}>
      <span className="mini-box-material" aria-hidden="true"/>
      {active&&<MiniBoxParticles/>}
      <header className="mini-box-header"><Glyph name="terminal" size={15}/><span className="mini-box-title">执行命令</span><small className="mini-box-protocol">{protocol}</small>
        <span className={`mini-box-status${active?' is-active':''}`} role="status"><i aria-hidden="true"/><span>{status}</span></span>
        <button type="button" className="mini-box-stop" disabled={!canStop} title="只终止此资源当前命令，其他资源继续" onClick={()=>void stop()}><Glyph name="stop" size={11}/>终止</button>
        <button type="button" className="mini-box-toggle" aria-label={open?'收起 mini 终端':'展开 mini 终端'} aria-expanded={open} onClick={()=>{setOpen(!open);onInspect?.();}}><Glyph name="chevron" size={13}/></button>
      </header>
      <div className="mini-box-viewport" hidden={!open}>
        {typeof window==='undefined'?<pre>{output}</pre>:<Suspense fallback={<pre>{output}</pre>}><TerminalPane key={target?`${target.history.terminal.id}:${target.history.terminal.generation}`:'recorded'} active={open} entries={[]} output={output} interactive={false} showCommandEntries={false} transparentBackground onInput={observeOnly} onResize={observeOnly}/></Suspense>}
      </div>
    </section>
    {error&&<p className="mini-box-error" role="alert">{error}</p>}
  </div>;
}

export function MiniBoxCompletionNotice({notices,startedAt,endedAt}:{notices:CommandStopNotice[];startedAt:string;endedAt?:string}) {
  const matches=notices.filter(notice=>Date.parse(notice.requestedAt)>=Date.parse(startedAt)&&(!endedAt||Date.parse(notice.requestedAt)<Date.parse(endedAt)));
  const resources=[...new Map(matches.map(notice=>[notice.resourceId,notice.resourceName])).values()];
  if(!resources.length)return null;
  return <p className="mini-box-completion-note" role="status"><Glyph name="stop" size={13}/><span>本轮已请求终止 {resources.join('、')} 的命令，已收到的输出保留；被终止命令的执行结果需核查，其他资源的结果独立保留。</span></p>;
}
