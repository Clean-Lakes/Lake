import {useEffect, useRef, useState, type FormEvent} from 'react';
import type {OperatorEffectConfirmation, OperatorEffectReview} from '../../shared/contracts';
import {AppSelect} from './AppSelect';
import {api, readableError} from './api';

type Judgment = NonNullable<OperatorEffectReview['judgment']>;
export type OperatorEffectDraft = Omit<Judgment,'effects'> & {effects:''|'none'|'observed'};
export type OperatorEffectChecks = {source:boolean;effects:boolean;processes:boolean};
const empty:OperatorEffectDraft={effects:'',directory:'',evidenceOperationId:'',actualEffects:'',processDisposition:'',remainingWork:'',operatorName:'',note:''};
const unchecked:OperatorEffectChecks={source:false,effects:false,processes:false};

export function operatorEffectConfirmation(review:OperatorEffectReview,draft:OperatorEffectDraft,checks:OperatorEffectChecks):OperatorEffectConfirmation|undefined {
  if ((!review.eligible && !review.closureEligible) || review.closureState || !review.revision || !checks.source || !checks.effects || !checks.processes ||
      !['none','observed'].includes(draft.effects) || !review.directories.includes(draft.directory) ||
      !review.evidence.some(e=>e.operationId===draft.evidenceOperationId && e.operationId!==review.operationId && e.directory===draft.directory)) return;
  for (const key of ['actualEffects','processDisposition','remainingWork','operatorName','note'] as const)
    if (!draft[key].trim() || draft[key].length>512) return;
  if (review.recorded && (!review.judgment || Object.keys(review.judgment).some(key=>
    review.judgment![key as keyof Judgment]!==draft[key as keyof OperatorEffectDraft]))) return;
  return {...draft,effects:draft.effects as 'none'|'observed',revision:review.revision,
    confirmSourceRead:true,confirmAllEffectsKnown:true,confirmRemoteProcessesAccounted:true,
    ...(review.closureEligible && {reconcileRisk:true})};
}

export function OperatorEffectReviewForm({review,connected,busy,error,onSubmit,onRefresh}:{review:OperatorEffectReview;connected:boolean;busy:boolean;error:string;onSubmit:(input:OperatorEffectConfirmation)=>void;onRefresh:()=>void}) {
  const [draft,setDraft]=useState<OperatorEffectDraft>(()=>review.judgment??{...empty,directory:review.directories.length===1?review.directories[0]:''});
  const [checks,setChecks]=useState(unchecked);
  if (review.closureState==='reconciled') return <p className="operation-review-resolved" role="status">原操作的影响已由操作者核实并结清。原执行结果与任务验收保留。</p>;
  if (!review.eligible && !review.closureEligible) return null;
  const evidence=review.evidence.find(e=>e.operationId===draft.evidenceOperationId);
  const update=(key:keyof OperatorEffectDraft,value:string)=>{setDraft(d=>({...d,[key]:value}));setChecks(unchecked);};
  const body=operatorEffectConfirmation(review,draft,checks);
  const submit=(event:FormEvent)=>{event.preventDefault();if(body&&connected&&!busy)onSubmit(body);};
  return <form className="operation-review" aria-label="实际影响人工复核" onSubmit={submit}>
    <h4>{review.closureEligible?'结清原操作的已知风险':'人工核实原操作的实际影响'}</h4>
    <p>原调用已结束，但不能据此认定远程进程已停止。请独立核对全部影响；目录快照只反映采样时的文件与进程。</p>
    <details><summary>查看完整原命令与回执</summary><pre>{review.command}</pre><pre>{review.output}</pre></details>
    {review.evidence.length===0?<p>尚无同一主机、目录和连接版本的完整后置观察。取得只读目录快照后刷新。</p>:null}
    <button className="button secondary" type="button" onClick={onRefresh} disabled={!connected||busy}>刷新独立证据</button>
    <fieldset disabled={!connected||busy||review.recorded}>
      <label>复核目录<AppSelect aria-label="实际影响复核目录" value={draft.directory} onChange={e=>update('directory',e.target.value)}>
        <option value="">请选择目录</option>{review.directories.map(d=><option key={d} value={d}>{d}</option>)}</AppSelect></label>
      <label>独立目录观察<AppSelect aria-label="选择完整目录观察" value={draft.evidenceOperationId} onChange={e=>update('evidenceOperationId',e.target.value)}>
        <option value="">请选择观察回执</option>{review.evidence.filter(e=>e.directory===draft.directory).map(e=><option key={e.operationId} value={e.operationId}>{new Date(e.at).toLocaleString('zh-CN',{hour12:false})} · {e.operationId.slice(0,10)}</option>)}</AppSelect></label>
      {evidence&&<div className="operation-review-evidence"><p>{evidence.summary}</p><details><summary>查看观察内容</summary><pre>{evidence.output}</pre></details></div>}
      <label>实际判定<AppSelect aria-label="实际影响判定" value={draft.effects} onChange={e=>update('effects',e.target.value)}>
        <option value="">请选择判定</option><option value="observed">已发生变更</option><option value="none">独立核实未写入</option></AppSelect></label>
      {([
        ['actualEffects','实际影响及逐项核对结果'],['processDisposition','原进程、遗留进程及处置或交接'],
        ['remainingWork','剩余工作及尚未满足的验收条件'],['operatorName','复核操作者'],['note','独立核实依据'],
      ] as const).map(([key,label])=><label key={key}>{label}<textarea rows={key==='operatorName'?1:2} maxLength={512} value={draft[key]} onChange={e=>update(key,e.target.value)}/></label>)}
    </fieldset>
    <fieldset disabled={!connected||busy||!evidence}>
      <label className="operation-review-consent"><input type="checkbox" checked={checks.source} onChange={e=>setChecks(c=>({...c,source:e.target.checked}))}/>我已核对完整原命令、输出和实际执行对象。</label>
      <label className="operation-review-consent"><input type="checkbox" checked={checks.effects} onChange={e=>setChecks(c=>({...c,effects:e.target.checked}))}/>我已独立查清全部实际影响，没有未核实的外部变更。</label>
      <label className="operation-review-consent"><input type="checkbox" checked={checks.processes} onChange={e=>setChecks(c=>({...c,processes:e.target.checked}))}/>远程遗留进程已结束，或已逐个核实身份、用途和后续管理责任。</label>
      {review.closureEligible&&<p>结清允许新的授权请求继续执行；不会重放原调用或将原任务改为通过。</p>}
      <button type="submit" className="button secondary" disabled={!body||!connected||busy}>{review.closureEligible?'确认结清风险':'登记人工判定'}</button>
    </fieldset>
    {error&&<p role="alert">{error}</p>}
  </form>;
}

export function OperatorEffectReconciliation({sessionId,operationId,connected,onUpdated}:{sessionId:string;operationId:string;connected:boolean;onUpdated:()=>void}) {
  const [review,setReview]=useState<OperatorEffectReview>(),[load,setLoad]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const alive=useRef(false),saving=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{if(!connected)return;const abort=new AbortController();
    void api.operatorEffectReview(sessionId,operationId,abort.signal).then(value=>{if(!abort.signal.aborted&&value.operationId===operationId)setReview(value);})
      .catch(cause=>{if(!abort.signal.aborted)setError(readableError(cause));});
    return()=>abort.abort();
  },[sessionId,operationId,connected,load]);
  const save=async(body:OperatorEffectConfirmation)=>{if(saving.current||!connected)return;saving.current=true;setBusy(true);setError('');
    try {const result=await api.confirmOperatorEffectReview(sessionId,operationId,body);
      if(result.operationId!==operationId||result.recorded!==true)throw new Error('未收到本笔人工复核回执');
      if(alive.current){setReview(undefined);setLoad(n=>n+1);onUpdated();}
    }catch(cause){if(alive.current){setError(readableError(cause));setReview(undefined);setLoad(n=>n+1);}}
    finally{saving.current=false;if(alive.current)setBusy(false);}
  };
  if(!review)return error?<p role="alert" className="super-task-control-error">{error} <button className="button secondary" onClick={()=>{setError('');setLoad(n=>n+1);}} disabled={!connected}>重新读取人工复核</button></p>:null;
  return <OperatorEffectReviewForm key={review.revision??operationId} review={review} connected={connected} busy={busy} error={error}
    onSubmit={input=>void save(input)} onRefresh={()=>{setError('');setLoad(n=>n+1);}}/>;
}
