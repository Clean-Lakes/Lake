import {useEffect,useRef,useState} from 'react';
import type {ProposedPlan,SessionSnapshot,WorkSession} from '../../shared/contracts';
import {api,readableError} from './api';
import {AssistantMarkdown,ObjectReferencesProvider} from './AssistantMarkdown';
import {Glyph} from './Icons';
import {PlanActions} from './PlanMode';

export function planTitle(plan:ProposedPlan):string {
 return plan.content.split('\n').map(line=>line.trim()).find(Boolean)?.replace(/^#{1,6}\s+/,'').replace(/\*\*/g,'')||'未命名计划';
}

export function SessionPlansPage({session,snapshot,error,disabled,onBack,onRetry,onRevise,onExecuted}:{session:WorkSession;snapshot:SessionSnapshot|null;error?:string;disabled:boolean;onBack:()=>void;onRetry:()=>void;onRevise:()=>void;onExecuted:()=>Promise<unknown>}) {
 const heading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{heading.current?.focus({preventScroll:true});},[session.id]);
 return <section className="session-plans-page" aria-label={`会话计划：${session.title}`}>
  <div className="session-plans-page-inner"><header className="session-plans-page-header"><button type="button" className="button secondary" onClick={onBack}><Glyph name="next" size={14}/>返回对话</button><h1 ref={heading} tabIndex={-1}>会话计划</h1><p>{session.title}</p></header>
   {snapshot?.session.id===session.id?<PlanList key={session.id} snapshot={snapshot} disabled={disabled} onRevise={onRevise} onExecuted={onExecuted}/>:error?<div className="record-empty" role="alert"><h2>计划未能加载</h2><p>{error}</p><button type="button" className="button secondary" onClick={onRetry}>重新加载</button></div>:<p className="plan-list-loading" role="status">正在加载会话计划…</p>}
  </div>
 </section>;
}

export function PlanList({snapshot,disabled,onRevise,onExecuted}:{snapshot:SessionSnapshot;disabled:boolean;onRevise:()=>void;onExecuted:()=>Promise<unknown>}) {
 const [plans,setPlans]=useState<ProposedPlan[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 const [selectedId,setSelectedId]=useState<string|null>(null);
 const listPosition=useRef(0),detailHeading=useRef<HTMLHeadingElement>(null),listHeading=useRef<HTMLHeadingElement>(null),returnToList=useRef(false);
 const session=snapshot.session.id,proposal=snapshot.ai?.proposedPlan?.id,status=snapshot.ai?.status;
 useEffect(()=>{
  let cancelled=false;
  setLoading(true);setError('');
  void api.plans(session).then(result=>{if(!cancelled)setPlans(result.plans);}).catch(error=>{if(!cancelled)setError(readableError(error));}).finally(()=>{if(!cancelled)setLoading(false);});
  return()=>{cancelled=true;};
 },[session,proposal,status,revision]);
 const executable=snapshot.conversationMode==='plan'&&status==='completed'&&snapshot.session.status==='completed';
 const selected=plans.find(plan=>plan.id===selectedId);
 useEffect(()=>{
  if(selected) {detailHeading.current?.focus({preventScroll:true});detailHeading.current?.closest('.session-plans-page')?.scrollTo(0,0);}
  else if(returnToList.current) {listHeading.current?.focus({preventScroll:true});listHeading.current?.closest('.session-plans-page')?.scrollTo(0,listPosition.current);returnToList.current=false;}
 },[selected?.id]);
 const openPlan=(id:string)=>{listPosition.current=listHeading.current?.closest('.session-plans-page')?.scrollTop||0;setSelectedId(id);};
 return <section className="plan-list" aria-label="计划列表" aria-busy={loading}>
  <header className="plan-list-header"><div>{selected?<button type="button" className="button secondary plan-list-back" onClick={()=>{returnToList.current=true;setSelectedId(null);}}><Glyph name="next" size={14}/>返回计划列表</button>:<h2 ref={listHeading} tabIndex={-1}>计划列表</h2>}<p>{!loading&&!error?`${plans.length} 份计划 · `:''}最新的排在前面</p></div><button type="button" className="icon-button" aria-label="刷新计划列表" disabled={loading} onClick={()=>setRevision(value=>value+1)}><Glyph name="refresh" size={16}/></button></header>
  {error&&<p role="alert" className="plan-mode-error">{error}<button type="button" className="button secondary" onClick={()=>setRevision(value=>value+1)}>重试</button></p>}
  {loading&&!plans.length&&<p role="status" className="plan-list-loading">正在加载计划…</p>}
  {!loading&&!error&&!plans.length&&<div className="record-empty"><Glyph name="document" size={24}/><h2>暂无计划</h2><p>在输入框开启 Plan 模式，描述目标；生成的完整计划会保存在这里。</p></div>}
  {selected?<ObjectReferencesProvider resources={snapshot.resources} tasks={snapshot.ai?.agentRuns}><article className="plan-list-content" aria-label="计划详情"><h2 ref={detailHeading} tabIndex={-1} className="plan-detail-heading">计划详情</h2><AssistantMarkdown tags={snapshot.session.tags}>{selected.content}</AssistantMarkdown>{executable&&proposal===selected.id&&<PlanActions disabled={disabled||!!snapshot.messageQueue?.items.length} onRevise={onRevise} onExecute={async()=>{await api.executePlan(session,selected.id);await onExecuted();}}/>}</article></ObjectReferencesProvider>:<PlanCatalog plans={plans} pendingId={executable?proposal:undefined} onOpen={openPlan}/>}
 </section>;
}

export function PlanCatalog({plans,pendingId,onOpen}:{plans:ProposedPlan[];pendingId?:string;onOpen:(id:string)=>void}) {
 return <ul className="plan-catalog" aria-label="已保存的计划">{plans.map((plan,index)=><li key={plan.id}><button type="button" className="plan-catalog-row" onClick={()=>onOpen(plan.id)}>
  <Glyph name="document" size={19}/><span className="plan-list-title"><span className="plan-catalog-title">{planTitle(plan)}</span><small><time dateTime={plan.at}>{new Date(plan.at).toLocaleString('zh-CN')}</time><span>{pendingId===plan.id?'待确认':index===0?'最新计划':'历史计划'}</span></small></span><span className="plan-catalog-open">查看详情</span><Glyph name="next" size={15}/>
 </button></li>)}</ul>;
}
