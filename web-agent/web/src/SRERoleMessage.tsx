import {DisclosureSummary} from './DisclosureSummary';
import {sessionInspectorId,useSessionInspector} from './SessionInspectorContext';
import {AssistantMarkdown} from './AssistantMarkdown';
import {useSmoothText} from './useSmoothText';
import {sreNeedsVerification,sreOperationLabel,sreReadCovered} from './sreOperationPolicy';
import {useEffect,useRef,useState,type ReactNode} from 'react';
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
import {PilotResourceExecution} from './PilotResourceExecution';
import {PilotAgentWork} from './PilotAgentWork';
import {pilotWorkForEntry} from './pilotPresentation';

function SREEvidence({task,evidence,register}:{task:SRETask;evidence:AgentEvidence;register:(node:HTMLDetailsElement|null)=>void}){
 const [source,setSource]=useState(''),[cursor,setCursor]=useState<number|null>(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const load=async()=>{setBusy(true);setError('');try{const value=await api.sreEvidence(task.sessionId,task.id,evidence.id,cursor??0);setSource(old=>old+value.source);setCursor(value.nextCursor)}catch(e){setError(readableError(e))}finally{setBusy(false)}};
 return <details ref={register} className="sre-evidence-item" onToggle={e=>{if(e.currentTarget.open&&!source&&!busy)void load()}}><DisclosureSummary>{evidence.title}<small>{evidence.resourceName} · {new Date(evidence.collectedAt).toLocaleTimeString('zh-CN')}</small></DisclosureSummary><pre>{source||evidence.excerpt}</pre>{cursor!==null&&<button type="button" disabled={busy} onClick={()=>void load()}>{busy?'读取中…':'继续读取原文'}</button>}{error&&<p role="alert">{error}</p>}</details>
}

function LiveProse({text,active,animateInitial}:{text:string;active:boolean;animateInitial:boolean}){
 const visible=useSmoothText(text,active,animateInitial);
 return <SREProse>{visible}</SREProse>;
}

export function SRERoleMessage({task,entry,thread,snapshot,renderApproval,onUpdated,animateInitial=false,connected=true,detailsOnly=false}:{detailsOnly?:boolean;thread?:SRETranscriptEntry[];task:SRETask;entry:SRETranscriptEntry;snapshot:SessionSnapshot;renderApproval:(run:NonNullable<SessionSnapshot['ai']>['agentRuns'] extends (infer T)[]|undefined?T:never)=>ReactNode;onUpdated:()=>void;animateInitial?:boolean;connected?:boolean}){
 const inspector=useSessionInspector();
 const useInspector=!!inspector&&!!task.pilot&&!detailsOnly;
 const openDetails=(evidenceId?:string)=>inspector?.open({sessionId:task.sessionId,taskId:task.id,task,attemptId:entry.attemptId,tab:'execution',evidenceId});
 const role=sreRoles[entry.roleId];if(!role)return null;
 const attempt=task.attempts?.find(a=>a.id===entry.attemptId),run=snapshot.ai?.agentRuns?.find(r=>r.id===entry.roleRunId);
 const [resolveId,setResolveId]=useState(''),[resolveNote,setResolveNote]=useState(''),[resolveError,setResolveError]=useState(''),[resolving,setResolving]=useState(false);
 const evidenceList=useRef<HTMLDetailsElement>(null),evidenceItems=useRef(new Map<string,HTMLDetailsElement>());
 const showEvidence=(id:string)=>{if(useInspector){openDetails(id);return;}const item=evidenceItems.current.get(id);if(!item||!evidenceList.current)return;evidenceList.current.open=true;item.open=true;item.querySelector('summary')?.focus({preventScroll:true});item.scrollIntoView({block:'nearest'})};
 const resolve=async(result:string)=>{setResolving(true);setResolveError('');try{await api.sreOperation(task.sessionId,task.id,'resolve',{expectedRevision:task.revision,operationId:resolveId,result,note:resolveNote});setResolveId('');onUpdated()}catch(e){setResolveError(readableError(e))}finally{setResolving(false)}};
 const firstPlan=thread?thread.some(m=>m.kind==='plan'):task.messages?.find(m=>m.kind==='plan')?.id===entry.id;
 const body=sreEvidenceText(entry.kind==='error'?displayAiError(entry.body):entry.body,attempt?.evidence??[]);
 const report=entry.kind==='finding'&&entry.source!=='user'?attempt?.report:undefined;
 const nodeReply=sreReplyStage(task,entry)==='node';
 const baseLive=sreRoleLiveState(task,entry,run,attempt);
 const threadRuns=thread?(snapshot.ai?.agentRuns??[]).filter(r=>r.sreTaskId===task.id&&thread.some(m=>m.roleRunId===r.id)):[];
 const outstanding=thread?(task.attempts??[]).filter(a=>thread.some(m=>m.attemptId===a.id||m.roleRunId===a.roleRunId)&&a.operations?.some(sreNeedsVerification)):[];
 const waitingRun=threadRuns.find(r=>r.pending||r.question);
 const live=outstanding.length?{...baseLive,active:false,label:'结果待核实',unknown:true}:waitingRun?{...baseLive,active:false,label:waitingRun.pending?'等待确认':waitingRun.question?.pilot?'等待选择':'等待补充'}:baseLive;
 const pilotWork=snapshot.sre?.pilot?pilotWorkForEntry(task,entry,snapshot.ai?.agentRuns):null;
 const calmProgress=!thread&&!!snapshot.sre?.pilot&&entry.kind==='progress'&&entry.source!=='user';
 const stableProgress=useRef({id:entry.id,body,hidden:pilotWork?.repeatsDescription===true});
 if(stableProgress.current.id!==entry.id)stableProgress.current={id:entry.id,body,hidden:pilotWork?.repeatsDescription===true};
 const visibleBody=useSmoothText(body,live.active&&entry.source!=='user'&&!calmProgress);
 const visibleNarration=useSmoothText(run?.liveText??'',live.active,animateInitial);
 const narration=run?.liveText||(entry.source==='model'?body:'');
 const showRecords=detailsOnly||['finding','result','verification','error'].includes(entry.kind);
 const approvalAnchor=task.messages?.find(m=>m.roleRunId===entry.roleRunId&&m.kind==='progress')??task.messages?.filter(m=>m.roleRunId===entry.roleRunId).at(-1);
 const showApproval=!!(run?.pending||run?.question)&&approvalAnchor?.id===entry.id;
 const approvalRuns=thread?threadRuns.filter(r=>r.pending||r.question):showApproval&&run?[run]:[];
 const priorErrors=[...new Map((thread??[]).filter(m=>m.kind==='error'&&m.id!==entry.id).map(m=>[m.body,m])).values()];
 const attemptMessages=task.messages?.filter(m=>m.attemptId===attempt?.id&&m.source!=='user')??[];
 const executionAnchor=attemptMessages.find(m=>m.kind==='progress')??attemptMessages[0];
 const showExecution=!!task.pilot&&!!attempt?.operations?.length&&(detailsOnly||executionAnchor?.id===entry.id);
 const successfulOps=attempt?.operations?.filter(op=>op.status==='succeeded')??[];
 const otherOps=attempt?.operations?.filter(op=>op.status!=='succeeded')??[];
 const operationRecord=(op:NonNullable<typeof attempt>['operations'][number])=><details className="sre-operation-record" id={`sre-operation-${op.id}`} key={op.id}><DisclosureSummary><Glyph name="terminal" size={13}/>{op.call.name} · {sreOperationLabel(op)}</DisclosureSummary><pre>{op.call.arguments}</pre>{op.result&&<pre>{op.result}</pre>}{attempt&&sreReadCovered(attempt.operations,attempt.readRecoveries??[],op)&&<p>此项原检查未完成，已取得替代检查证据。</p>}{op.resolutionNote&&<p>人工核实 · {op.resolutionNote}</p>}{sreNeedsVerification(op)&&['paused','waiting_input'].includes(task.status)&&<button type="button" onClick={()=>{setResolveId(op.id);setResolveNote('');setResolveError('')}}>记录核实结果</button>}</details>;
 useEffect(()=>{
  const id=inspector?.selection?.evidenceId;
  if(detailsOnly&&id&&inspector?.selection?.attemptId===entry.attemptId){const frame=requestAnimationFrame(()=>showEvidence(id));return()=>cancelAnimationFrame(frame);}
 },[detailsOnly,inspector?.selection,entry.attemptId]);
 return <article className={`sre-role-message${thread?' sre-role-conversation':''}${detailsOnly?' inspector-attempt-details':''} sre-role-${entry.roleId}${entry.kind==='status'?' sre-role-status':''}`} id={detailsOnly?undefined:`sre-message-${thread?.[0]?.id??entry.id}`} tabIndex={-1} data-role={entry.roleId}>
  {!detailsOnly&&<span className="sre-role-avatar">{entry.source==='user'?<Glyph name="chat" size={18}/>:<AgentIcon role={entry.roleId} size={22}/>}</span>}<div className="sre-role-content">{!detailsOnly&&<header><strong>{entry.source==='user'?'你':role.name}</strong><small>{entry.source==='user'?'计划与操作记录':role.description}</small><>{entry.toRoleId&&sreRoles[entry.toRoleId]&&<span className="sre-role-recipient"><Glyph name="arrow" size={12}/>{sreRoles[entry.toRoleId].name}</span>}</><time>{new Date(entry.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time>{(!!thread||['progress','status'].includes(entry.kind))&&<span className={`sre-role-live-state${live.active?' is-active':''}`} role="status"><StatusText text={live.label} active={live.active}/></span>}</header>}
   {!detailsOnly&&pilotWork&&<PilotAgentWork work={pilotWork} onInspectStep={useInspector?stepId=>{const planRun=task.runs.filter(value=>value.planRevisionId===pilotWork.plan.id).at(-1);const attempt=task.attempts.filter(value=>value.planRunId===planRun?.id&&value.stepId===stepId).at(-1);inspector.open({sessionId:task.sessionId,taskId:task.id,task,attemptId:attempt?.id,tab:attempt?'execution':'plan'});}:undefined}/>}
   {!detailsOnly&&(calmProgress?(!stableProgress.current.hidden&&<div className="sre-role-body"><SREProse>{stableProgress.current.body}</SREProse></div>):(!pilotWork?.repeatsDescription||!!run?.liveText)&&<div className={`sre-role-body${entry.kind==='error'?' sre-role-error':''}`}>{thread?<AssistantMarkdown>{report?.summary??(entry.kind==='progress'&&run?.liveText?visibleNarration:visibleBody)}</AssistantMarkdown>:entry.kind==='progress'&&run?.liveText?<LiveProse key={run.liveTextId} text={sreEvidenceText(run.liveText,attempt?.evidence??[])} active={live.active} animateInitial={animateInitial}/>:report?<SREReport compact report={report} evidence={attempt?.evidence??[]} onEvidence={showEvidence}/>:nodeReply?<SRECheckpoint body={body}/>:<SREProse compact={['summary','finding'].includes(entry.kind)}>{visibleBody}</SREProse>}</div>)}
   {showExecution&&!useInspector&&attempt&&<PilotResourceExecution task={task} attempt={attempt} snapshot={snapshot} run={run} active={live.active} connected={connected}/>}
   {!detailsOnly&&live.active&&run&&(!showExecution||useInspector)&&<SREActivity run={run} attempt={attempt} snapshotClock={!!snapshot.sre?.pilot} compact={!!thread} onInspect={useInspector?()=>openDetails():undefined}/>}
   {!useInspector&&calmProgress&&narration&&<details className="sre-live-record"><DisclosureSummary>运行详情</DisclosureSummary><SREProse>{sreEvidenceText(narration,attempt?.evidence??[])}</SREProse></details>}
   {firstPlan&&!detailsOnly&&(useInspector?<button type="button" className="inspector-inline-link" aria-controls={sessionInspectorId} onClick={()=>inspector.open({sessionId:task.sessionId,taskId:task.id,task,tab:'plan'})}><Glyph name="document" size={14}/>查看任务计划<Glyph name="arrow" size={13}/></button>:<SREPlanCard enabled={snapshot.sre?.enabled===true} task={task} resources={snapshot.resources} agentRuns={snapshot.ai?.agentRuns} onUpdated={onUpdated}/>)}
   {showRecords&&!useInspector&&!!attempt?.evidence?.length&&<details ref={evidenceList} className="sre-evidence-list"><DisclosureSummary>{attempt.evidence.length} 项证据<span>查看原始输出</span></DisclosureSummary>{attempt.evidence.map(ev=><SREEvidence key={ev.id} task={task} evidence={ev} register={node=>{if(node)evidenceItems.current.set(ev.id,node);else evidenceItems.current.delete(ev.id)}}/>)}</details>}
   {!detailsOnly&&approvalRuns.map(r=><div key={r.id} className="sre-approval-slot">{renderApproval(r)}</div>)}
   {!!outstanding.length&&<div className="sre-role-error">执行结果待核实{outstanding.map(a=><button key={a.id} type="button" className="inspector-inline-link" onClick={()=>inspector?.open({sessionId:task.sessionId,taskId:task.id,task,attemptId:a.id,tab:'execution'})}>查看对应操作<Glyph name="next" size={11}/></button>)}</div>}
   {!!priorErrors.length&&<details className="sre-role-error"><DisclosureSummary>需关注的记录 · {priorErrors.length}</DisclosureSummary>{priorErrors.map(m=><SREProse key={m.id}>{displayAiError(m.body)}</SREProse>)}</details>}
   {showRecords&&!useInspector&&(!detailsOnly||!showExecution)&&!!successfulOps.length&&<details className="sre-operation-group"><DisclosureSummary><Glyph name="terminal" size={13}/>{successfulOps.length} 项操作记录</DisclosureSummary>{successfulOps.map(operationRecord)}</details>}
   {showRecords&&!useInspector&&otherOps.filter(op=>!detailsOnly||!showExecution||sreNeedsVerification(op)).map(operationRecord)}
   {useInspector&&attempt&&!(thread&&live.active)&&(showExecution||showRecords)&&<button type="button" className="inspector-inline-link" aria-controls={sessionInspectorId} onClick={()=>openDetails()}><Glyph name="lakeProcess" size={15}/>执行详情{attempt.operations?.length?` · ${attempt.operations.length} 项操作`:''}{attempt.evidence?.length?` · ${attempt.evidence.length} 项证据`:''}<Glyph name="arrow" size={13}/></button>}
   {resolveId&&['paused','waiting_input'].includes(task.status)&&attempt?.operations?.some(op=>op.id===resolveId&&sreNeedsVerification(op))&&<div className="sre-plan-edit"><label>核实依据<textarea value={resolveNote} maxLength={2000} onChange={e=>setResolveNote(e.target.value)} placeholder="说明实际状态、检查方法及时间"/></label><p>确认已执行后会跳过该动作，继续独立验证。确认未执行后，继续任务将重新提交该动作并按当前权限确认。</p><button type="button" disabled={resolving||!resolveNote.trim()} onClick={()=>void resolve('succeeded')}>确认已执行</button><button type="button" disabled={resolving||!resolveNote.trim()} onClick={()=>void resolve('not_executed')}>确认未执行</button><button type="button" onClick={()=>setResolveId('')}>取消</button>{resolveError&&<p role="alert">{resolveError}</p>}</div>}
   {!detailsOnly&&!sreTaskActive(task)&&entry.id===task.messages?.at(-1)?.id&&<p className="sre-outcome">{task.recoveryStatus==='verified'?(task.plans.at(-1)?.taskType==='recovery'?'恢复已验证':'验收已通过'):task.recoveryStatus==='not_applicable'?'调查结束':'恢复尚未验证'} · {task.rootCauseStatus==='confirmed'?'根因已确认':'根因未确认'}</p>}
  </div>
 </article>
}
