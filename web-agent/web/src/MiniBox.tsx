import {useId,useLayoutEffect,useRef,useState} from 'react';
import type {AICard,CommandStopNotice} from '../../shared/contracts';
import {api} from './api';
import {Glyph} from './Icons';
import {miniCanStop,miniControlActive,miniTarget,type MiniBoxScope} from './miniBoxModel';
import {miniAnomalyLine,miniPreview,miniPreviewRows,miniReadableOutput,miniRecordedEntry,miniRecordedEntries,retainMiniPreview,miniExecutionStatus,type MiniPreview} from './miniBoxPreview';
import {useMiniBox} from './useMiniBox';
import {MiniBoxControl} from './MiniBoxControl';

export function MiniBox({scope,resource,kind,cards,onInspect}:{scope:MiniBoxScope;resource:string;kind:'local'|'ssh';cards:AICard[];onInspect?:()=>void}) {
  const protocol=kind==='local'?'本机':'SSH';
  const {histories,stale,refresh}=useMiniBox(scope,resource);
  const target=miniTarget(histories);
  const [open,setOpen]=useState(!scope.parallel),[fullOpen,setFullOpen]=useState(false),[pending,setPending]=useState(''),[error,setError]=useState(''),[jump,setJump]=useState(0);
  const disclosure=useRef({manual:false,autoFolded:!!scope.parallel});
  // Entering parallel execution folds untouched boxes once. A later completion
  // never expands them again, and every explicit viewing choice wins.
  if(scope.parallel&&!disclosure.current.manual&&!disclosure.current.autoFolded){disclosure.current.autoFolded=true;setOpen(false);}
  function inspect(){disclosure.current.manual=true;onInspect?.();}
  const detailId=useId(),detail=useRef<HTMLDivElement>(null);
  const observed=useRef<{scope:string;entries:Map<string,{output:string;preview:MiniPreview}>}>({scope:'',entries:new Map()});
  const observationScope=JSON.stringify([scope.session,resource,scope.startedAt,scope.endedAt]);
  if(observed.current.scope!==observationScope)observed.current={scope:observationScope,entries:new Map()};
  const liveEntries=histories.flatMap(history=>history.entries.map(entry=>({entry,key:`${history.terminal.id}:${history.terminal.generation}:${entry.id}`}))).sort((a,b)=>Date.parse(a.entry.startedAt??a.entry.createdAt)-Date.parse(b.entry.startedAt??b.entry.createdAt));
  const recorded=miniRecordedEntry(cards.at(-1));
  const records=liveEntries.length?liveEntries:miniRecordedEntries(cards).map(entry=>({entry,key:`recorded:${entry.id}`}));
  const allowed=new Set(records.map(row=>row.key));
  for(const key of observed.current.entries.keys())if(!allowed.has(key))observed.current.entries.delete(key);
  const analyzed=records.map(row=>{
    const previous=observed.current.entries.get(row.key);
    if(previous&&previous.output===row.entry.output)return {...row,preview:previous.preview};
    const preview=retainMiniPreview(previous,row.entry.output);
    observed.current.entries.set(row.key,{output:row.entry.output,preview});
    return {...row,preview};
  });
  const last=cards.at(-1);
  const dispatching=!!target&&last?.status==='running'&&Date.parse(last.at)>Date.parse(target.entry.startedAt??target.entry.createdAt);
  const current=dispatching&&recorded?{entry:recorded,preview:miniPreview(recorded.output)}:analyzed.find(row=>row.entry.id===target?.entry.id)??analyzed.at(-1);
  const preview=current?.preview??miniPreview('');
  const rows=miniPreviewRows(preview,preview.anomalies[0]);
  const anomalyCount=analyzed.reduce((count,row)=>count+row.preview.anomalies.length,0);
  const retainedOnly=analyzed.some(row=>row.preview.retainedOnly);
  const lineCount=analyzed.reduce((count,row)=>count+row.preview.lineCount,0);
  useLayoutEffect(()=>{
    if(!fullOpen||!jump||!detail.current)return;
    const issue=detail.current.querySelector<HTMLElement>('[data-mini-anomaly]');
    if(issue){detail.current.scrollTop+=issue.getBoundingClientRect().top-detail.current.getBoundingClientRect().top-8;detail.current.focus({preventScroll:true});}
  },[fullOpen,jump]);
  const currentKey=target?`${target.history.terminal.id}:${target.entry.id}`:'';
  const stopping=!!target&&(!!target.entry.stopRequestedAt||pending===currentKey);
  const canStop=miniCanStop(target,scope,stale)&&!stopping&&!dispatching;
  const active=miniControlActive(scope,cards.find(card=>card.status==='running'),target,stale,stopping);
  const status=miniExecutionStatus({entry:current?.entry,card:last,stale,stopping,active,anomalies:preview.anomalies.length,dispatching});
  async function stop(){
    if(!canStop||!target)return;
    setPending(currentKey);setError('');onInspect?.();
    try {await api.terminalInterruptCommand(scope.session,target.history.terminal.id,target.history.terminal.generation,target.entry.id);refresh();}
    catch{setError('终止未确认，请核查当前命令状态。');setPending('');refresh();}
  }
  return <div className="mini-box-container">
    <section className={`mini-box${active?' is-operating':''}${open?'':' is-collapsed'}`} aria-label={`Mini Box ${protocol} 命令终端`}>
      <span className="mini-box-material" aria-hidden="true"/>
      <MiniBoxControl active={active}/>
      <header className="mini-box-header"><Glyph name="terminal" size={15}/><span className="mini-box-title">执行命令</span><small className="mini-box-protocol">{protocol}</small>
        <span className={`mini-box-status${active?' is-active':''}`} role="status"><i aria-hidden="true"/><span>{status}</span></span>
        {!open&&anomalyCount>0&&<button type="button" className="mini-box-folded-anomalies" title="展开并定位异常线索" onClick={()=>{setOpen(true);setFullOpen(true);setJump(value=>value+1);inspect();}}>异常 {anomalyCount}</button>}
        <button type="button" className="mini-box-stop" disabled={!canStop} title="只终止此资源当前命令，其他资源继续" onClick={()=>void stop()}><Glyph name="stop" size={11}/>终止</button>
        <button type="button" className="mini-box-toggle" aria-label={open?'收起 mini 终端':'展开 mini 终端'} aria-expanded={open} onClick={()=>{setOpen(!open);if(open)setFullOpen(false);inspect();}}><Glyph name="chevron" size={13}/></button>
      </header>
      <div className="mini-box-preview" hidden={!open}>
        <div className="mini-box-command" title={current?.entry.command||'等待命令派发'}><span aria-hidden="true">$</span><code>{current?.entry.command?current.entry.command.replace(/\r?\n/g,' ⏎ '):'等待命令派发…'}</code></div>
        <div className="mini-box-output" aria-label="关键输出预览">{rows.length?rows.map((line,index)=><div key={index} className={line.anomaly?'mini-box-output-line is-anomaly':'mini-box-output-line'} title={line.text}><span>{line.text}</span>{line.count>1&&<small>× {line.count}</small>}</div>):<div className="mini-box-output-empty">{current?.entry.status==='running'?'等待命令输出…':'暂无输出'}</div>}</div>
        <footer className="mini-box-footer">
          {anomalyCount>0&&<button type="button" className="mini-box-anomalies" onClick={()=>{setFullOpen(true);setJump(value=>value+1);inspect();}}>异常线索 {anomalyCount}</button>}
          {current?.entry.exitCode!=null&&<span className={current.entry.exitCode!==0?'mini-box-exit is-failed':'mini-box-exit'}>退出码 {current.entry.exitCode}</span>}
          <button type="button" className="mini-box-expand" aria-expanded={fullOpen} aria-controls={detailId} onClick={()=>{setFullOpen(!fullOpen);inspect();}}>{fullOpen?'收起':retainedOnly?'保留输出':'完整输出'}<small> · {lineCount} 行</small><Glyph name="chevron" size={11}/></button>
        </footer>
      </div>
    </section>
    {fullOpen&&<section id={detailId} className="mini-box-details" aria-label="原始命令输出">
      <header><span>原始命令输出</span><button type="button" aria-label="收起完整输出" onClick={()=>setFullOpen(false)}><Glyph name="close" size={13}/></button></header>
      {retainedOnly&&<p className="mini-box-retention-note">终端记录有容量上限，以下显示已保留的输出；已观察到的异常线索单独保留。</p>}
      <div ref={detail} className="mini-box-raw" tabIndex={0} aria-label="原始输出记录">{analyzed.map(({entry,key,preview:recordPreview})=><div className="mini-box-raw-entry" key={key}>
        <pre className="mini-box-raw-command">$ {entry.command||'命令记录'}</pre>
        {recordPreview.anomalies.filter(issue=>!miniReadableOutput(entry.output).includes(issue.text)).map((issue,index)=><div key={index} data-mini-anomaly className="mini-box-retained-anomaly"><small>先前观察到的异常线索</small><pre>{issue.text}{issue.context?'\n'+issue.context:''}</pre></div>)}
        <pre>{miniReadableOutput(entry.output).split('\n').map((line,index)=><span key={index} data-mini-anomaly={miniAnomalyLine(line)?'':undefined} className={miniAnomalyLine(line)?'is-anomaly':undefined}>{line}{'\n'}</span>)}</pre>
      </div>)}</div>
    </section>}
    {error&&<p className="mini-box-error" role="alert">{error}</p>}
  </div>;
}

export function MiniBoxCompletionNotice({notices,startedAt,endedAt}:{notices:CommandStopNotice[];startedAt:string;endedAt?:string}) {
  const matches=notices.filter(notice=>Date.parse(notice.requestedAt)>=Date.parse(startedAt)&&(!endedAt||Date.parse(notice.requestedAt)<Date.parse(endedAt)));
  const resources=[...new Map(matches.map(notice=>[notice.resourceId,notice.resourceName])).values()];
  if(!resources.length)return null;
  return <p className="mini-box-completion-note" role="status"><Glyph name="stop" size={13}/><span>本轮已请求终止 {resources.join('、')} 的命令，已收到的输出保留；被终止命令的执行结果需核查，其他资源的结果独立保留。</span></p>;
}
