import {useRef,useState} from 'react';
import type {AIQuestionRequest,PilotSelection} from '../../shared/contracts';
import {api,readableError} from './api';
import {DisclosureSummary} from './DisclosureSummary';
import {Glyph} from './Icons';

type Props={session:string;request:AIQuestionRequest;refresh:()=>Promise<unknown>;runId?:string};

export function PilotChoiceQuestion(props:Props){
 if(!props.request.pilot||!props.request.questions[0])return null;
 return <PilotChoice key={JSON.stringify([props.session,props.runId,props.request.id])} {...props}/>;
}

function PilotChoice({session,request,refresh,runId}:Props){
 const choice=request.pilot!;
 const [directionId,setDirectionId]=useState(()=>choice.directions.find(direction=>direction.recommended)?.id??choice.directions[0]?.id??'');
 const [checked,setChecked]=useState<Record<string,string[]>>({});
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const submitting=useRef(false);
 const direction=choice.directions.find(value=>value.id===directionId);
 if(!direction)return null;
 const selected=checked[direction.id];
 const operations=selected??direction.operations.filter(operation=>operation.risk==='readonly').map(operation=>operation.id);
 const valid=selected===undefined||operations.length>0&&direction.operations.filter(operation=>operations.includes(operation.id)).every(operation=>(operation.dependsOn??[]).every(id=>operations.includes(id)));
 async function submit(selection:PilotSelection){
  if(submitting.current)return;submitting.current=true;setBusy(true);setError('');
  try{await api.aiOperation(session,runId?'agentQuestionReply':'questionReply',{id:request.id,...(runId?{runId}:{}),answers:{[request.questions[0]!.id]:[JSON.stringify(selection)]}});await refresh()}
  catch(e){setError(readableError(e));submitting.current=false;setBusy(false)}
 }
 return <section className="pilot-choice" aria-label="选择当前步骤的方向或命令" aria-busy={busy}>
  <div className="pilot-choice-heading"><span>处理方向</span><button type="button" className="pilot-choice-delegate" disabled={busy} onClick={()=>void submit({level:'step'})}>本步骤交给 Lake<Glyph name="arrow" size={12}/></button></div>
  <fieldset className="pilot-directions" disabled={busy} data-single={choice.directions.length===1}><legend className="visually-hidden">选择处理方向</legend>
   {choice.directions.map(value=><div className="pilot-direction" key={value.id}>
    <label className="pilot-direction-option">{choice.directions.length>1&&<input type="radio" name={`pilot-direction-${request.id}`} checked={value.id===direction.id} onChange={()=>setDirectionId(value.id)}/>}<span className="pilot-direction-title" title={value.title}>{value.title}</span>{value.recommended&&<small>推荐</small>}</label>
    {value.id===direction.id&&value.reason&&<p className="pilot-direction-reason" title={value.reason}>{value.reason}</p>}
   </div>)}
  </fieldset>
  <details key={direction.id} className="pilot-command-options" onToggle={event=>{if(event.currentTarget.open)setChecked(value=>value[direction.id]===undefined?{...value,[direction.id]:operations}:value)}}>
   <DisclosureSummary>选择具体操作<small>{direction.operations.length} 项</small></DisclosureSummary>
   <fieldset disabled={busy}><legend className="visually-hidden">选择具体命令或操作</legend>{direction.operations.map(operation=><div className="pilot-operation" key={operation.id}>
    <label className="pilot-operation-option"><input type="checkbox" checked={operations.includes(operation.id)} onChange={()=>setChecked(value=>({...value,[direction.id]:operations.includes(operation.id)?operations.filter(id=>id!==operation.id):[...operations,operation.id]}))}/><span className="pilot-operation-title">{operation.title}</span><small>{operation.risk==='readonly'?'只读':'变更'}</small></label>
    {typeof operation.arguments.command==='string'?<code className="pilot-command-preview">{operation.arguments.command}</code>:null}
    <details className="pilot-operation-parameters"><DisclosureSummary>工具与参数</DisclosureSummary><pre>{operation.tool}{'\n'}{JSON.stringify(operation.arguments,null,2)}</pre></details>
   </div>)}</fieldset>
   {!valid&&<p className="pilot-selection-hint">{operations.length?'请同时选择所需的前置操作。':'请选择至少一项操作。'}</p>}
  </details>
  {error&&<p className="form-error" role="alert">{error}</p>}
  <div className="pilot-choice-footer"><button type="button" className="pilot-choice-cancel" disabled={busy} onClick={()=>void submit({level:'cancel'})}>暂不执行</button><button type="button" className="pilot-choice-primary" disabled={busy||!valid} onClick={()=>void submit(selected===undefined?{level:'direction',directionId:direction.id}:{level:'command',directionId:direction.id,operationIds:operations})}>{busy?'正在提交…':selected===undefined?'按此方向继续':`执行所选 ${operations.length} 项`}<Glyph name="arrow" size={12}/></button></div>
 </section>;
}
