import {useId,useRef,useState} from 'react';
import type {SpecialistChannelInfo,SessionSnapshot} from '../../shared/contracts';
import {Glyph} from './Icons';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {ExecutionAgentIcon} from './ExecutionAgentIcon';
import {filterSpecialistTasks,groupSpecialistTasks,specialistTaskRows,specialistTaskSteps,specialistTaskTime,type SpecialistTaskFilter,type SpecialistTaskRow} from './specialistTaskListModel';
import type {SuperWorker} from '../../shared/contracts';
import {usePageVisible} from './usePageVisible';
import {ConversationReadButton,ConversationReadMarker} from './ConversationReadMarker';

const filters:{id:SpecialistTaskFilter;label:string}[]=[{id:'all',label:'全部任务'},{id:'active',label:'进行中'},{id:'attention',label:'需关注'},{id:'completed',label:'已完成'}];
export function SpecialistTaskSteps({snapshot,worker,connected}:{snapshot:SessionSnapshot;worker?:SuperWorker;connected:boolean}){
 const visible=usePageVisible();
 const steps=specialistTaskSteps(snapshot);
 const working=connected&&snapshot.ai?.status==='running'&&!['completed','failed','cancelled'].includes(snapshot.superagent?.task.state??'');
 const labels:Record<string,string>={completed:'已完成',running:working?'执行中':'上次进行至此',pending:'待执行',queued:'排队中',waiting_user:'待确认',waiting_external:'等待外部结果',blocked:'待核实',failed:'执行失败',cancelled:'已停止',paused:'已暂停'};
 const latest=worker?.sessionId===snapshot.session.id&&worker.task.taskId===snapshot.superagent?.task.taskId?worker.activity?.label:undefined;
 return <section className="specialist-inspector-steps" aria-label="任务步骤" data-hidden={!visible||undefined}>
  {steps.length>0?<><p className="specialist-step-caption">任务进度 {steps.filter(step=>step.status==='completed').length} / {steps.length}</p><ol>{steps.map(step=><li key={step.id} data-state={step.status}><span className="specialist-step-mark"><Glyph name={step.status==='completed'?'check':step.status==='running'&&working?'loader':['failed','blocked','waiting_user'].includes(step.status)?'alert':'clock'} size={15}/></span><div><strong>{step.title}</strong><small>{labels[step.status]??'状态待核实'}</small></div></li>)}</ol></>:<p className="inspector-empty">尚无已记录的执行步骤，后续进展会显示在这里。</p>}
  {latest&&<div className="specialist-task-latest"><span><ExecutionAgentIcon agent={worker?.execution?.backend.kind==='acp'?worker.execution.backend.agent:undefined} size={15}/>最新进展</span><p>{latest}</p></div>}
 </section>;
}
export function SpecialistTaskMetadata({snapshot,worker}:{snapshot:SessionSnapshot;worker?:SuperWorker}){
 if(!worker||worker.sessionId!==snapshot.session.id||worker.task.taskId!==snapshot.superagent?.task.taskId)return null;
 const row=specialistTaskRows({workers:[worker],active:[snapshot],projectId:snapshot.session.projectId,resources:snapshot.resources,resourceTree:snapshot.resourceTree})[0];
 if(!row)return null;
 return <dl className="specialist-inspector-meta"><div><dt>执行 Agent</dt><dd><ExecutionAgentIcon agent={worker.execution?.backend.kind==='acp'?worker.execution.backend.agent:undefined} size={15}/>{row.agent}</dd></div></dl>;
}
export function SpecialistTaskList({channel,rows,selectedSessionId,onTask,connected=true,loading=false,routing=false,queued=0,error='',onRetry}:{channel:SpecialistChannelInfo;rows:SpecialistTaskRow[];selectedSessionId?:string;onTask:(sessionId:string)=>void;connected?:boolean;loading?:boolean;routing?:boolean;queued?:number;error?:string;onRetry?:()=>void}){
 const pageVisible=usePageVisible();
 const surface=useRef<HTMLDivElement>(null);
 const [filter,setFilter]=useState<SpecialistTaskFilter>('all'),[query,setQuery]=useState('');
 const id=useId(),visible=filterSpecialistTasks(rows,filter,query);
 const groups=groupSpecialistTasks(visible,filter==='all'&&!query.trim());
 const count=(kind:SpecialistTaskFilter)=>kind==='all'?rows.length:rows.filter(row=>row.filter===kind).length;
 const attention=count('attention');
 const moving=connected&&(routing||rows.some(row=>row.moving));
 const status=!connected?'正在重连':moving?'处理中':attention?'需关注':'待命';
 return <div ref={surface} className="specialist-task-page" aria-label={`${channel.roleName}的任务`} data-hidden={!pageVisible||undefined}>
  <header className="specialist-page-heading">
   <div className="specialist-page-identity"><SuperRoleAvatar name={channel.roleName} roleId={channel.roleId} motion={moving?'working':attention?'still':'idle'}/><div><div className="specialist-page-title"><h1>{channel.roleName}</h1><span className="specialist-page-state" data-active={moving||undefined}>{moving&&<Glyph name="loader" size={12}/>} {status}</span></div>{channel.duties&&<p>{channel.duties}</p>}</div></div>
   <div className="specialist-page-actions"><ConversationReadButton key={channel.sessionId} session={channel.sessionId} state={channel.messageRead} disabled={!connected}/></div>
  </header>
  <ConversationReadMarker session={channel.sessionId} state={channel.messageRead} enabled={connected&&!loading&&!error} surface={surface}/>
  <div className="specialist-task-toolbar">
   <div className="specialist-task-filters" role="tablist" aria-label="筛选专员任务" onKeyDown={event=>{
    const index=filters.findIndex(item=>item.id===filter);
    const next=event.key==='Home'?0:event.key==='End'?filters.length-1:event.key==='ArrowRight'?(index+1)%filters.length:event.key==='ArrowLeft'?(index+filters.length-1)%filters.length:-1;
    if(next<0)return;event.preventDefault();setFilter(filters[next].id);(event.currentTarget.children[next] as HTMLButtonElement)?.focus();
   }}>{filters.map(item=><button key={item.id} type="button" role="tab" id={`${id}-${item.id}`} aria-selected={filter===item.id} tabIndex={filter===item.id?0:-1} aria-controls={`${id}-tasks`} onClick={()=>setFilter(item.id)}>{item.label}<span>{count(item.id)}</span></button>)}</div>
   <label className="specialist-task-search"><Glyph name="search" size={15}/><input type="search" aria-label="搜索专员任务" placeholder="搜索任务…" value={query} onChange={event=>setQuery(event.target.value)}/></label>
  </div>
  {error&&<div className="specialist-page-error" role="alert"><Glyph name="alert" size={14}/><span>{error}</span>{onRetry&&<button type="button" onClick={onRetry}>重新获取</button>}</div>}
  {(routing||queued>0)&&<p className="specialist-task-admitting" role="status"><Glyph name={connected?'loader':'clock'} size={13}/>{routing?'正在分配新任务…':`${queued} 项请求等待分配`}</p>}
  <div id={`${id}-tasks`} role="tabpanel" aria-labelledby={`${id}-${filter}`} className="specialist-task-panel" aria-busy={loading}>
   {visible.length>0?<ul className="specialist-task-rows" aria-label="专员任务列表">{groups.flatMap(group=>[
    ...(group.label?[<li key={`group:${group.id}`} role="presentation" className="specialist-task-group-heading"><h2>{group.label}</h2></li>]:[]),
    ...group.rows.map(row=>{
    const {worker,state,progress}=row,selected=selectedSessionId===worker.sessionId;
    const context=worker.activity?.label;
    const icon=connected&&row.moving?'loader':state.tone==='success'?'check':state.tone==='attention'||state.tone==='danger'?'alert':worker.task.state==='cancelled'?'stop':'clock';
    const updated=specialistTaskTime(row.updatedAt);
    return <li key={`task:${worker.id}`} data-task-id={worker.task.taskId} data-session-id={worker.sessionId} data-selected={selected||undefined}>
     <button type="button" className="specialist-task-open" aria-label={`查看任务：${worker.task.title}`} aria-current={selected?'true':undefined} onClick={()=>onTask(worker.sessionId)}>
      <SuperRoleAvatar name={worker.roleName} roleId={worker.roleId} motion={connected&&row.moving?'working':'still'}/>
      <span className="specialist-task-copy">
       <span className="specialist-task-topline"><strong title={worker.task.title}>{worker.task.title}</strong>{updated!=='—'&&<time dateTime={row.updatedAt} title={new Date(row.updatedAt!).toLocaleString('zh-CN',{hour12:false})}>{updated}</time>}</span>
       <span className="specialist-task-meta">
        <span className="specialist-task-state" data-tone={state.tone}><Glyph name={icon} size={11}/><span>{state.label}</span></span>
        <span className="specialist-task-agent"><ExecutionAgentIcon agent={worker.execution?.backend.kind==='acp'?worker.execution.backend.agent:undefined} size={12}/><span>{row.agent}</span></span>
        {context&&<span className="specialist-task-context" title={context}>{context}</span>}
        {progress?<span className="specialist-task-progress"><span role="progressbar" aria-label={`${worker.task.title}步骤进度`} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.completed}><i style={{width:`${100*progress.completed/progress.total}%`}}/></span><small>{progress.completed} / {progress.total}</small></span>:<span className="visually-hidden">步骤进度未报告</span>}
       </span>
      </span>
      <span className="specialist-task-chevron"><Glyph name="next" size={13}/></span>
     </button>
    </li>;
   })])}</ul>:<div className="specialist-tasks-empty"><Glyph name={query?'search':'layers'} size={26}/><h2>{loading?'正在读取任务…':query?'没有匹配的任务':rows.length?'此分类暂无任务':'还没有任务'}</h2><p>{loading?'正在获取这位专员的任务记录。':query?'试试任务名称、资源目录或执行 Agent。':rows.length?'切换分类查看其他任务。':'由 Pilot 派发任务，进展和结果会显示在这里。'}</p>{(query||filter!=='all')&&<button type="button" className="button secondary" onClick={()=>{setQuery('');setFilter('all');}}>查看全部任务</button>}</div>}
  </div>
  {visible.length>0&&(filter!=='all'||query.trim())&&<p className="specialist-task-list-count" role="status">已显示 {visible.length} 项任务{visible.length<rows.length&&`，共 ${rows.length} 项`}</p>}
 </div>;
}
