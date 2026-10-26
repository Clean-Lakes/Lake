import {InspectorTaskSummary} from './InspectorTaskSummary';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {SessionSnapshot,SRETranscriptEntry} from '../../shared/contracts';
import {AgentIcon} from './AgentIcon';
import {Glyph} from './Icons';
import {AppSelect} from './AppSelect';
import {ObjectReferencesProvider} from './AssistantMarkdown';
import {SREPlanCard} from './SREPlanCard';
import {SRERoleMessage} from './SRERoleMessage';
import {sreRoles,sreStatus,sreStepStatus} from './sreTranscript';
import {inspectedTask,inspectedAttempt,inspectorAttempts} from './sessionInspectorModel';
import {sessionInspectorId,useSessionInspector,type InspectorSelection} from './SessionInspectorContext';

export function SessionInspector({snapshot,connected,onUpdated}:{snapshot:SessionSnapshot;connected:boolean;onUpdated:()=>void}){
 const inspector=useSessionInspector()!;
 const selection=inspector.selection?.sessionId===snapshot.session.id?inspector.selection:null;
 const retained=useRef<InspectorSelection|null>(selection);
 if(selection)retained.current=selection;
 const [present,setPresent]=useState(!!selection),panel=useRef<HTMLElement>(null);
 useEffect(()=>{
  if(selection){setPresent(true);return;}
  const timer=setTimeout(()=>setPresent(false),window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:180);
  return()=>clearTimeout(timer);
 },[!!selection]);
 const target=selection??retained.current;
 const task=target?inspectedTask(snapshot,target):undefined;
 const plan=task?.plans?.at(-1);
 const selected=task?inspectedAttempt(task,target?.attemptId):undefined;
 useLayoutEffect(()=>{
  if(selection&&!selection.automatic&&panel.current&&!panel.current.contains(document.activeElement))panel.current.focus({preventScroll:true});
 },[selection]);
 if((!present&&!selection)||!target||target.sessionId!==snapshot.session.id)return null;
 const options=task?inspectorAttempts(task):[];
 if(selected&&!options.some(item=>item.attempt.id===selected.attempt.id))options.unshift(selected);
 const currentEntry=selected&&task?(task.messages?.find(entry=>entry.attemptId===selected.attempt.id&&entry.kind==='progress')??task.messages?.find(entry=>entry.attemptId===selected.attempt.id)??{id:`inspector-${selected.attempt.id}`,sessionId:task.sessionId,taskId:task.id,roleId:selected.step.role,roleRunId:selected.attempt.roleRunId,attemptId:selected.attempt.id,kind:'progress',body:'',source:'runtime',sequence:0,revision:0,createdAt:selected.attempt.startedAt} satisfies SRETranscriptEntry):undefined;
 const attemptStatus=selected&&task?(selected.attempt.planRunId===task.runs?.at(-1)?.id?sreStepStatus(task,selected.step,snapshot.ai?.agentRuns):selected.attempt.status):'';
 const choose=(tab:'plan'|'execution',attemptId=target.attemptId)=>inspector.open({...target,tab,attemptId,evidenceId:undefined,automatic:false});
 return <aside ref={panel} id={sessionInspectorId} tabIndex={-1} className={`session-inspector${selection?' is-open':' is-closing'}`} inert={!selection} aria-hidden={!selection} aria-label="任务检查" onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();inspector.close();}}}>
  <header className="session-inspector-heading"><div><strong>任务检查</strong><p>{task?'Lake Pilot · 计划与执行':snapshot.session.title}</p></div><button type="button" className="icon-button" aria-label="关闭任务检查" onClick={inspector.close}><Glyph name="close" size={16}/></button></header>
  <div className="session-inspector-tabs" role="tablist" aria-label="任务视图" onKeyDown={event=>{if(task&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();choose(event.key==='Home'?'plan':event.key==='End'?'execution':target.tab==='plan'?'execution':'plan');requestAnimationFrame(()=>panel.current?.querySelector<HTMLButtonElement>('[role=tab][aria-selected=true]')?.focus());}}}>
   <button type="button" role="tab" id="inspector-plan-tab" aria-selected={target.tab==='plan'} aria-controls="inspector-plan-panel" tabIndex={target.tab==='plan'?0:-1} disabled={!task} onClick={()=>choose('plan')}>任务计划</button>
   <button type="button" role="tab" id="inspector-execution-tab" aria-selected={target.tab==='execution'} aria-controls="inspector-execution-panel" tabIndex={target.tab==='execution'?0:-1} onClick={()=>choose('execution',selected?.attempt.id)}>执行详情</button>
  </div>
  <ObjectReferencesProvider resources={snapshot.resources} tasks={snapshot.ai?.agentRuns}>
   <div className="session-inspector-scroll">
    {task&&<InspectorTaskSummary task={task} title={snapshot.session.title} runs={snapshot.ai?.agentRuns}/>}
    <div role="tabpanel" id="inspector-plan-panel" aria-labelledby="inspector-plan-tab" hidden={target.tab!=='plan'}>
     {task&&plan?<SREPlanCard task={task} resources={snapshot.resources} agentRuns={snapshot.ai?.agentRuns} enabled={connected&&snapshot.sre?.enabled===true} onUpdated={onUpdated} inspector onInspectStep={stepId=>{const attempt=inspectorAttempts(task).find(item=>item.step.id===stepId)?.attempt;if(attempt)choose('execution',attempt.id);}}/>:<p className="inspector-empty">计划生成后会显示在这里。</p>}
    </div>
    <div role="tabpanel" id="inspector-execution-panel" aria-labelledby="inspector-execution-tab" hidden={target.tab!=='execution'}>
     {task&&<><label className="inspector-step-select">查看步骤<AppSelect value={selected?.attempt.id??''} onChange={event=>choose('execution',event.target.value)} disabled={!selected}>{!selected&&<option value="">尚无执行记录</option>}{options.map(({step,attempt})=><option key={attempt.id} value={attempt.id}>{sreRoles[step.role].name} · {step.description}</option>)}</AppSelect></label>{selected&&<div className="inspector-attempt-heading"><AgentIcon role={selected.step.role} size={20}/><strong>{sreRoles[selected.step.role].name}</strong><span>{sreStatus[attemptStatus]??attemptStatus}</span><p>{selected.step.description}</p></div>}{currentEntry?<SRERoleMessage key={`${task.id}:${currentEntry.attemptId}`} detailsOnly connected={connected} task={task} entry={currentEntry} snapshot={snapshot} onUpdated={onUpdated} renderApproval={()=>null}/>:<p className="inspector-empty">本步骤尚无执行记录。</p>}</>}
     {!task&&!target.turnId&&<p className="inspector-empty">本轮尚无执行记录。</p>}
     <div ref={inspector.setHost} className="inspector-turn-host"/>
    </div>
   </div>
  </ObjectReferencesProvider>
  <footer className="session-inspector-footer"><span>主对话保持在当前位置</span><button type="button" onClick={inspector.close}>返回对话<Glyph name="arrow" size={13}/></button></footer>
 </aside>;
}
