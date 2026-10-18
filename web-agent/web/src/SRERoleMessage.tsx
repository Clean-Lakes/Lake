import {DisclosureSummary} from './DisclosureSummary';
import {useSmoothText} from './useSmoothText';
import {sreNeedsVerification,sreOperationLabel} from './sreOperationPolicy';
import {useRef,useState,type ReactNode} from 'react';
import type {SessionSnapshot,SRETask,SRETranscriptEntry,AgentEvidence} from '../../shared/contracts';
import {AgentIcon} from './AgentIcon';
import {Glyph} from './Icons';
import {SREPlanCard} from './SREPlanCard';
import {sreRoles,sreTaskActive,sreReplyStage} from './sreTranscript';
import {api,readableError} from './api';
import {SREProse,SREReport,SRECheckpoint,sreEvidenceText} from './SREReport';
import {SREActivity,sreRoleLiveState} from './SREActivity';
import {StatusText} from './StatusText';
import {displayAiError} from './aiErrors';

function SREEvidence({task,evidence,register}:{task:SRETask;evidence:AgentEvidence;register:(node:HTMLDetailsElement|null)=>void}){
 const [source,setSource]=useState(''),[cursor,setCursor]=useState<number|null>(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const load=async()=>{setBusy(true);setError('');try{const value=await api.sreEvidence(task.sessionId,task.id,evidence.id,cursor??0);setSource(old=>old+value.source);setCursor(value.nextCursor)}catch(e){setError(readableError(e))}finally{setBusy(false)}};
 return <details ref={register} className="sre-evidence-item" onToggle={e=>{if(e.currentTarget.open&&!source&&!busy)void load()}}><DisclosureSummary>{evidence.title}<small>{evidence.resourceName} · {new Date(evidence.collectedAt).toLocaleTimeString('zh-CN')}</small></DisclosureSummary><pre>{source||evidence.excerpt}</pre>{cursor!==null&&<button type="button" disabled={busy} onClick={()=>void load()}>{busy?'读取中…':'继续读取原文'}</button>}{error&&<p role="alert">{error}</p>}</details>
}

function LiveProse({text,active,animateInitial}:{text:string;active:boolean;animateInitial:boolean}){
 const visible=useSmoothText(text,active,animateInitial);
 return <SREProse>{visible}</SREProse>;
}

export function SRERoleMessage({task,entry,snapshot,renderApproval,onUpdated,animateInitial=false}:{task:SRETask;entry:SRETranscriptEntry;snapshot:SessionSnapshot;renderApproval:(run:NonNullable<SessionSnapshot['ai']>['agentRuns'] extends (infer T)[]|undefined?T:never)=>ReactNode;onUpdated:()=>void;animateInitial?:boolean}){
 const role=sreRoles[entry.roleId];if(!role)return null;
 const attempt=task.attempts?.find(a=>a.id===entry.attemptId),run=snapshot.ai?.agentRuns?.find(r=>r.id===entry.roleRunId);
 const [resolveId,setResolveId]=useState(''),[resolveNote,setResolveNote]=useState(''),[resolveError,setResolveError]=useState(''),[resolving,setResolving]=useState(false);
 const evidenceList=useRef<HTMLDetailsElement>(null),evidenceItems=useRef(new Map<string,HTMLDetailsElement>());
 const showEvidence=(id:string)=>{const item=evidenceItems.current.get(id);if(!item||!evidenceList.current)return;evidenceList.current.open=true;item.open=true;item.querySelector('summary')?.focus({preventScroll:true});item.scrollIntoView({block:'nearest'})};
 const resolve=async(result:string)=>{setResolving(true);setResolveError('');try{await api.sreOperation(task.sessionId,task.id,'resolve',{expectedRevision:task.revision,operationId:resolveId,result,note:resolveNote});setResolveId('');onUpdated()}catch(e){setResolveError(readableError(e))}finally{setResolving(false)}};
 const firstPlan=task.messages?.find(m=>m.kind==='plan')?.id===entry.id;
 const body=sreEvidenceText(entry.kind==='error'?displayAiError(entry.body):entry.body,attempt?.evidence??[]);
 const report=entry.kind==='finding'&&entry.source!=='user'?attempt?.report:undefined;
 const nodeReply=sreReplyStage(task,entry)==='node';
 const live=sreRoleLiveState(task,entry,run,attempt);
 const visibleBody=useSmoothText(body,live.active&&entry.source!=='user');
 const showRecords=['finding','result','verification','error'].includes(entry.kind);
 const approvalAnchor=task.messages?.find(m=>m.roleRunId===entry.roleRunId&&m.kind==='progress')??task.messages?.filter(m=>m.roleRunId===entry.roleRunId).at(-1);
 const showApproval=!!(run?.pending||run?.question)&&approvalAnchor?.id===entry.id;
 const successfulOps=attempt?.operations?.filter(op=>op.status==='succeeded')??[];
 const otherOps=attempt?.operations?.filter(op=>op.status!=='succeeded')??[];
 const operationRecord=(op:NonNullable<typeof attempt>['operations'][number])=><details className="sre-operation-record" id={`sre-operation-${op.id}`} key={op.id}><DisclosureSummary><Glyph name="terminal" size={13}/>{op.call.name} · {sreOperationLabel(op)}</DisclosureSummary><pre>{op.call.arguments}</pre>{op.result&&<pre>{op.result}</pre>}{op.resolutionNote&&<p>人工核实 · {op.resolutionNote}</p>}{sreNeedsVerification(op)&&['paused','waiting_input'].includes(task.status)&&<button type="button" onClick={()=>{setResolveId(op.id);setResolveNote('');setResolveError('')}}>记录核实结果</button>}</details>;
 return <article className={`sre-role-message sre-role-${entry.roleId}${entry.kind==='status'?' sre-role-status':''}`} id={`sre-message-${entry.id}`} data-role={entry.roleId}>
  <span className="sre-role-avatar">{entry.source==='user'?<Glyph name="chat" size={18}/>:<AgentIcon role={entry.roleId} size={22}/>}</span><div className="sre-role-content"><header><strong>{entry.source==='user'?'你':role.name}</strong><small>{entry.source==='user'?'计划与操作记录':role.description}</small><>{entry.toRoleId&&sreRoles[entry.toRoleId]&&<span className="sre-role-recipient"><Glyph name="arrow" size={12}/>{sreRoles[entry.toRoleId].name}</span>}</><time>{new Date(entry.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time>{['progress','status'].includes(entry.kind)&&<span className={`sre-role-live-state${live.active?' is-active':''}`} role="status"><StatusText text={live.label} active={live.active}/></span>}</header>
   <div className={`sre-role-body${entry.kind==='error'?' sre-role-error':''}`}>{entry.kind==='progress'&&run?.liveText?<LiveProse key={run.liveTextId} text={sreEvidenceText(run.liveText,attempt?.evidence??[])} active={live.active} animateInitial={animateInitial}/>:report?<SREReport compact report={report} evidence={attempt?.evidence??[]} onEvidence={showEvidence}/>:nodeReply?<SRECheckpoint body={body}/>:<SREProse compact={['summary','finding'].includes(entry.kind)}>{visibleBody}</SREProse>}</div>
   {live.active&&run&&<SREActivity run={run} attempt={attempt}/>}
   {firstPlan&&<SREPlanCard enabled={snapshot.sre?.enabled===true} task={task} resources={snapshot.resources} agentRuns={snapshot.ai?.agentRuns} onUpdated={onUpdated}/>}
   {showRecords&&!!attempt?.evidence?.length&&<details ref={evidenceList} className="sre-evidence-list"><DisclosureSummary>{attempt.evidence.length} 项证据<span>查看原始输出</span></DisclosureSummary>{attempt.evidence.map(ev=><SREEvidence key={ev.id} task={task} evidence={ev} register={node=>{if(node)evidenceItems.current.set(ev.id,node);else evidenceItems.current.delete(ev.id)}}/>)}</details>}
   {showApproval&&run&&<div className="sre-approval-slot">{renderApproval(run)}</div>}
   {showRecords&&!!successfulOps.length&&<details className="sre-operation-group"><DisclosureSummary><Glyph name="terminal" size={13}/>{successfulOps.length} 项操作记录</DisclosureSummary>{successfulOps.map(operationRecord)}</details>}
   {showRecords&&otherOps.map(operationRecord)}
   {resolveId&&['paused','waiting_input'].includes(task.status)&&attempt?.operations?.some(op=>op.id===resolveId&&sreNeedsVerification(op))&&<div className="sre-plan-edit"><label>核实依据<textarea value={resolveNote} maxLength={2000} onChange={e=>setResolveNote(e.target.value)} placeholder="说明实际状态、检查方法及时间"/></label><p>确认已执行后会跳过该动作，继续独立验证。确认未执行后，继续任务将重新提交该动作并按当前权限确认。</p><button type="button" disabled={resolving||!resolveNote.trim()} onClick={()=>void resolve('succeeded')}>确认已执行</button><button type="button" disabled={resolving||!resolveNote.trim()} onClick={()=>void resolve('not_executed')}>确认未执行</button><button type="button" onClick={()=>setResolveId('')}>取消</button>{resolveError&&<p role="alert">{resolveError}</p>}</div>}
   {!sreTaskActive(task)&&entry.id===task.messages?.at(-1)?.id&&<p className="sre-outcome">{task.recoveryStatus==='verified'?(task.plans.at(-1)?.taskType==='recovery'?'恢复已验证':'验收已通过'):task.recoveryStatus==='not_applicable'?'调查结束':'恢复尚未验证'} · {task.rootCauseStatus==='confirmed'?'根因已确认':'根因未确认'}</p>}
  </div>
 </article>
}
