import {useState} from 'react';
import type {AIQuestionRequest} from '../../shared/contracts';
import {api,readableError} from './api';
import {DisclosureSummary} from './DisclosureSummary';
import {Glyph} from './Icons';

export function PilotChoiceQuestion({session,request,refresh,runId}:{session:string;request:AIQuestionRequest;refresh:()=>Promise<unknown>;runId?:string}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const [checked,setChecked]=useState<Record<string,string[]>>({});
 const choice=request.pilot;if(!choice||!request.questions[0])return null;
 async function submit(level:'step'|'direction'|'command'|'cancel',directionId?:string,operationIds?:string[]){
  if(busy)return;setBusy(true);setError('');
  try{await api.aiOperation(session,runId?'agentQuestionReply':'questionReply',{id:request.id,...(runId?{runId}:{}),answers:{[request.questions[0]!.id]:[JSON.stringify({level,...(directionId?{directionId}:{}),...(operationIds?{operationIds}:{})})]}});await refresh()}
  catch(e){setError(readableError(e));setBusy(false)}
 }
 return <section className="pilot-choice" aria-label="选择当前步骤的方向或命令" aria-busy={busy}>
  <div className="pilot-choice-heading"><span>选择处理方向</span><button type="button" disabled={busy} onClick={()=>void submit('step')}>交给 Lake 完成本步骤<Glyph name="arrow" size={12}/></button></div>
  {choice.directions.map(direction=>{
   const selected=checked[direction.id]??direction.operations.filter(operation=>operation.risk==='readonly').map(operation=>operation.id);
   const valid=selected.length>0&&direction.operations.filter(operation=>selected.includes(operation.id)).every(operation=>(operation.dependsOn??[]).every(id=>selected.includes(id)));
   return <details className="pilot-direction" key={direction.id}><DisclosureSummary><span>{direction.title}{direction.recommended&&<small>推荐</small>}</span></DisclosureSummary>
    <p className="pilot-direction-reason">{direction.reason}</p><button type="button" className="pilot-direction-continue" disabled={busy} onClick={()=>void submit('direction',direction.id)}>按此方向继续<Glyph name="arrow" size={12}/></button>
    <fieldset disabled={busy}><legend className="visually-hidden">选择具体命令或操作</legend>{direction.operations.map(operation=><label className="pilot-operation" key={operation.id}>
     <input type="checkbox" checked={selected.includes(operation.id)} onChange={()=>setChecked(value=>({...value,[direction.id]:selected.includes(operation.id)?selected.filter(id=>id!==operation.id):[...selected,operation.id]}))}/>
     <span><span className="pilot-operation-title">{operation.title}<small>{operation.risk==='readonly'?'只读':'变更'}</small></span><code>{typeof operation.arguments.command==='string'?operation.arguments.command:`${operation.tool} ${JSON.stringify(operation.arguments)}`}</code></span>
    </label>)}</fieldset>
    <div className="pilot-choice-footer"><small>已选 {selected.length} 项 · 尚未执行</small><button type="button" disabled={busy||!valid} onClick={()=>void submit('command',direction.id,selected)}>执行所选检查<Glyph name="arrow" size={12}/></button></div>
    {!valid&&selected.length>0&&<p className="pilot-direction-reason">请同时选择所需的前置操作。</p>}
   </details>;
  })}
  {error&&<p className="form-error" role="alert">{error}</p>}
  <button type="button" className="pilot-choice-cancel" disabled={busy} onClick={()=>void submit('cancel')}>暂不执行本步骤</button>
 </section>;
}
