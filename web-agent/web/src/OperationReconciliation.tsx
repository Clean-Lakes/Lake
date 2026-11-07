import {useEffect, useRef, useState, type FormEvent} from 'react';
import type {OperationReview, OperationReviewConfirmation, SessionSnapshot} from '../../shared/contracts';
import {AppSelect} from './AppSelect';
import {api, readableError} from './api';

export function reviewableCommandIds(snapshot: SessionSnapshot, executionId: string) {
  const task = snapshot.superagent?.task;
  if (snapshot.session.workspaceRole !== 'worker' || task?.sessionId !== snapshot.session.id ||
      (task.executionGoalId ?? task.taskId) !== executionId || task.projectId !== snapshot.session.projectId) return [];
  return [...new Set((snapshot.commandExecutions ?? []).filter(command =>
    command.operationId && command.taskId === executionId && command.sessionId === snapshot.session.id &&
    command.operationState === 'unknown').map(command => command.operationId))];
}

export function reviewConfirmation(review: OperationReview, evidenceId: string, note: string, confirmed: boolean): OperationReviewConfirmation | undefined {
  const reason = note.trim();
  if (!review.eligible || review.resolved || !review.revision || !confirmed || !reason || reason.length > 512 ||
      !review.evidence.some(item => item.operationId === evidenceId && item.operationId !== review.operationId)) return;
  return {revision: review.revision, evidenceOperationId: evidenceId, note: reason, ...(review.effects === "observed" ? {confirmObservedEffects: true as const} : {confirmNoWrite: true as const})};
}

export function OperationReviewForm({review, connected, busy, failed, onSubmit, onRefresh}: {
  review: OperationReview; connected: boolean; busy: boolean; failed: string;
  onSubmit: (value: OperationReviewConfirmation) => void; onRefresh: () => void;
}) {
  const [selected, setSelected] = useState(''), [note, setNote] = useState(''), [confirmed, setConfirmed] = useState(false);
  const observed = review.effects === "observed";
  if (review.resolved) return <p className="operation-review-resolved" role="status">{observed ? "已登记实际变更。原任务仍保留失败记录。" : "已核实此操作未写入。"}</p>;
  if (!review.eligible || !review.revision) return null;
  const evidence = review.evidence.find(item => item.operationId === selected);
  const request = reviewConfirmation(review, selected, note, confirmed);
  const submit = (event: FormEvent) => {event.preventDefault(); if (request && connected && !busy) onSubmit(request);};
  return <form className="operation-review" onSubmit={submit} aria-label="操作人工复核">
    <h4>{observed ? "核实原操作的实际变更" : "核实原操作是否写入"}</h4>
    {observed && <p>请核对原命令及完整执行输出，确认变更范围和剩余风险。登记后其他任务可以继续执行。</p>}
    <p>复核目录 <code>{review.directory}</code></p>
    <details><summary>查看原命令</summary><pre>{review.command}</pre></details>
    {review.evidence.length === 0 ? <p>请在原主机对该目录执行独立只读复查，取得回执后刷新。 <button type="button" className="button secondary" onClick={onRefresh} disabled={busy||!connected}>刷新证据</button></p> :
      <fieldset disabled={busy||!connected}>
        <label>独立复查回执<AppSelect value={selected} aria-label="选择独立复查回执" onChange={event=>{setSelected(event.target.value);setConfirmed(false);}}>
          <option value="">请选择回执</option>{review.evidence.map(item=><option key={item.operationId} value={item.operationId}>
            {new Date(item.at).toLocaleString('zh-CN',{hour12:false})} · {item.operationId.slice(0,10)}
          </option>)}</AppSelect></label>
        {evidence && <div className="operation-review-evidence"><p>{evidence.summary}</p><code>{evidence.operationId}</code>
          <details><summary>查看复查命令</summary><pre>{evidence.command}</pre></details></div>}
        <label>判定依据<textarea rows={2} maxLength={512} value={note} onChange={event=>{setNote(event.target.value);setConfirmed(false);}}/></label>
        <label className="operation-review-consent"><input type="checkbox" disabled={!evidence||!note.trim()} checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>{observed ? "我已独立核实实际变更和进程终态，确认其余任务可以继续执行。" : "我已核对独立回执，确认原操作未写入。"}</label>
        <button type="submit" className="button secondary" disabled={!request || busy || !connected}>登记复核结果</button>
      </fieldset>}
    {failed && <p role="alert">{failed}</p>}
  </form>;
}

function CommandReview({sessionId, operationId, connected, onUpdated}: {sessionId:string;operationId:string;connected:boolean;onUpdated:()=>void}) {
  const [review,setReview] = useState<OperationReview>(), [load,setLoad] = useState(0);
  const [pending,setPending]=useState(false), [error,setError]=useState('');
  const alive=useRef(false), saving=useRef(false);
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if (!connected) return;
    const abort=new AbortController();
    void api.operationReview(sessionId,operationId,abort.signal).then(next=>{
      if (!abort.signal.aborted && next.operationId===operationId) setReview(next);
    }).catch(cause=>{if(!abort.signal.aborted) setError(readableError(cause));});
    return ()=>abort.abort();
  },[sessionId,operationId,connected,load]);
  const save=async (body:OperationReviewConfirmation)=>{
    if(saving.current || !connected) return;
    saving.current=true;setPending(true);setError('');
    try{
      const result=await api.confirmOperationReview(sessionId,operationId,body);
      if(result.operationId!==operationId || !result.resolved) throw new Error('未收到本次操作的复核回执');
      if(alive.current){setReview({operationId,eligible:false,resolved:true,evidence:[],effects:review?.effects});onUpdated();}
    } catch(cause) {
      if(alive.current){setError(readableError(cause));setReview(undefined);setLoad(n=>n+1);}
    } finally {saving.current=false;if(alive.current)setPending(false);}
  };
  if(!review) return error?<p role="alert" className="super-task-control-error">{error} <button type="button" className="button secondary" onClick={()=>{setError('');setLoad(n=>n+1);}} disabled={!connected}>重新读取复核记录</button></p>:null;
  return <OperationReviewForm key={review.revision ?? operationId} review={review} connected={connected} busy={pending}
    failed={error} onRefresh={()=>setLoad(n=>n+1)} onSubmit={value=>void save(value)}/>;
}

export function OperationReconciliation({snapshot,executionId,connected,onUpdated}:{
  snapshot:SessionSnapshot;executionId:string;connected:boolean;onUpdated:()=>void;
}) {
  return <>{reviewableCommandIds(snapshot,executionId).map(id=><CommandReview key={id} sessionId={snapshot.session.id}
    operationId={id} connected={connected} onUpdated={onUpdated}/>)}</>;
}
