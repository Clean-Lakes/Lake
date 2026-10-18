import {sreNeedsVerification} from './sreOperationPolicy';
import {useEffect,useState} from 'react';
import type {Resource,SRETask} from '../../shared/contracts';
import {Glyph} from './Icons';
import {api,readableError} from './api';

export function sreUnresolvedOperations(task:SRETask){
 const found=new Map<string,NonNullable<SRETask['attempts']>[number]['operations'][number]>();
 for(const a of task.attempts??[])for(const op of a.operations??[])if(sreNeedsVerification(op))found.set(op.id,op);
 return [...found.values()];
}
function locateOperation(id:string){
 const target=document.getElementById(`sre-operation-${id}`);
 if(!target)return false;
 if(target instanceof HTMLDetailsElement)target.open=true;
 for(let parent=target.parentElement;parent;parent=parent.parentElement)if(parent instanceof HTMLDetailsElement)parent.open=true;
 target.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
 target.querySelector('summary')?.focus({preventScroll:true});
 return true;
}
export function SREBlockers({task,resources,onUpdated}:{task:SRETask;resources:Resource[];onUpdated:()=>void}){
 const blockers=sreUnresolvedOperations(task),[pending,setPending]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{if(pending&&locateOperation(pending))setPending('')},[pending,task.revision]);
 if(!blockers.length)return null;
 const inspect=async(id:string)=>{setError('');if(locateOperation(id))return;setPending(id);if(['active','waiting_approval'].includes(task.status)){setBusy(true);try{await api.sreOperation(task.sessionId,task.id,'control',{action:'pause',expectedRevision:task.revision,clientRequestId:crypto.randomUUID()});onUpdated()}catch(e){setError(readableError(e));setPending('')}finally{setBusy(false)}}else setError('原操作记录正在更新，请刷新后查看。')};
 return <div className="sre-plan-blockers" role="status"><p><Glyph name="alert" size={14}/><strong>{blockers.length} 项操作结果待核实</strong><span>核实前不会重复变更；仍可只读核查</span></p>{blockers.map(op=><div key={op.id}><span>{resources.find(r=>r.id===op.resourceId)?.name??'目标资源'} · {op.call.name}</span><button type="button" disabled={busy} onClick={()=>void inspect(op.id)}>{busy&&pending===op.id?'正在暂停…':'查看并核实'}<Glyph name="arrow" size={12}/></button></div>)}{error&&<p role="alert">{error}</p>}</div>
}
