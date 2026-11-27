import {useId,useRef,useState,type KeyboardEvent,type ReactNode} from 'react';
import type {SpecialistChannelInfo,SessionSnapshot} from '../../shared/contracts';
import {Glyph} from './Icons';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {ExecutionAgentIcon} from './ExecutionAgentIcon';
import {filterSpecialistTasks,groupTaskSource,specialistTaskRows,specialistTaskSteps,specialistTaskTime,type SpecialistTaskFilters,type SpecialistTaskRow,type SpecialistTaskSource,type SpecialistTaskSources} from './specialistTaskListModel';
import type {SuperWorker} from '../../shared/contracts';
import {usePageVisible} from './usePageVisible';
import {ConversationReadButton,ConversationReadMarker} from './ConversationReadMarker';
import {TaskSpecialistAvatars} from './TaskSpecialistAvatars';
import {ActivityDots} from './ActivityIndicator';
import {AgentBackendLogo,agentTypeName} from './AgentBackendLogo';
import {ChatGroupAvatars} from './ChatGroup';
import {channelTaskPresentation} from './superAgentPresentation';

export function SpecialistTaskSteps({snapshot,worker,connected}:{snapshot:SessionSnapshot;worker?:SuperWorker;connected:boolean}){
 const visible=usePageVisible();
 const steps=specialistTaskSteps(snapshot);
 const working=connected&&snapshot.ai?.status==='running'&&!['completed','failed','cancelled'].includes(snapshot.superagent?.task.state??'');
 const labels:Record<string,string>={completed:'已完成',running:working?'执行中':'上次进行至此',pending:'待执行',queued:'排队中',waiting_user:'待确认',waiting_external:'等待外部结果',blocked:'未完成',unknown:'结果不确定',failed:'执行失败',cancelled:'已停止',paused:'已暂停'};
 const latest=worker?.sessionId===snapshot.session.id&&worker.task.taskId===snapshot.superagent?.task.taskId?worker.activity?.label:undefined;
 return <section className="specialist-inspector-steps" aria-label="任务步骤" data-hidden={!visible||undefined}>
  {steps.length>0?<><p className="specialist-step-caption">任务进度 {steps.filter(step=>step.status==='completed').length} / {steps.length}</p><ol>{steps.map(step=><li key={step.id} data-state={step.status}><span className="specialist-step-mark"><Glyph name={step.status==='completed'?'check':step.status==='running'&&working?'loader':['failed','blocked','waiting_user'].includes(step.status)?'alert':'clock'} size={15}/></span><div><strong>{step.title}</strong><small>{labels[step.status]??'状态未报告'}</small></div></li>)}</ol></>:<p className="inspector-empty">尚无已记录的执行步骤，后续进展会显示在这里。</p>}
  {latest&&<div className="specialist-task-latest"><span><ExecutionAgentIcon agent={worker?.execution?.backend.kind==='acp'?worker.execution.backend.agent:undefined} size={15}/>最新进展</span><p>{latest}</p></div>}
 </section>;
}
export function SpecialistTaskMetadata({snapshot,worker,details=false,connected=true,sources,onOpenSource}:{
 snapshot:SessionSnapshot;worker?:SuperWorker;details?:boolean;connected?:boolean;sources?:SpecialistTaskSources;onOpenSource?:OpenSpecialistTaskSource;
}){
 const task=snapshot.superagent?.task;
 if(!task||!worker||worker.sessionId!==snapshot.session.id||worker.task.taskId!==task.taskId)return null;
 const execution=snapshot.superagent?.execution??worker.execution;
 const row=specialistTaskRows({workers:[{...worker,task,execution}],active:[snapshot],projectId:snapshot.session.projectId,resources:snapshot.resources,resourceTree:snapshot.resourceTree,sources})[0];
 if(!row)return null;
 const status=channelTaskPresentation(task);
 const originSessionId=row.source.sessionId;
 const updated=row.updatedAt&&new Date(row.updatedAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
 const openOrigin=originSessionId&&onOpenSource?()=>onOpenSource(originSessionId):undefined;
 return <dl className="specialist-inspector-meta">
  {details&&<>
   <div><dt>任务来源</dt><dd><SpecialistTaskSourceChip source={row.source} onOpen={openOrigin}/></dd></div>
   <div><dt>当前状态</dt><dd>
    <span className="specialist-detail-status" data-tone={row.needsConfirmation?'attention':status.tone}>{row.needsConfirmation?'待确认':status.label}</span>
    {connected&&row.moving&&<ActivityDots compact/>}
    {updated&&<time className="specialist-detail-time" dateTime={row.updatedAt}>更新于 {updated}</time>}
   </dd></div>
   <div><dt>参与专员</dt><dd>{row.members.map(member=><span className="specialist-detail-member" key={member.key}>
    <SuperRoleAvatar roleId={member.roleId} name={member.name} size={17} motion="still"/>{member.name}
   </span>)}</dd></div>
  </>}
  <div><dt>执行 Agent</dt><dd><ExecutionAgentIcon agent={execution?.backend.kind==='acp'?execution.backend.agent:undefined} size={15}/>{row.agent}</dd></div>
  {details&&row.paths.length>0&&<div><dt>关联资源</dt><dd>{row.paths.map(path=><span className="specialist-detail-resource" key={path} title={path}>{path}</span>)}</dd></div>}
 </dl>;
}
const sourceOrder={group:0,lake:1,external:2,specialist:3,unknown:4};
export type OpenSpecialistTaskSource=(sessionId:string,filters?:SpecialistTaskFilters,worker?:SuperWorker)=>void;

function TaskSourceIcon({kind,size=13}:{kind:SpecialistTaskSource['kind'];size?:number}){
 if(kind==='lake')return <SuperRoleAvatar pilot size={size} motion="still"/>;
 return <Glyph name={kind==='external'?'plug':kind==='unknown'?'document':'chat'} size={size}/>;
}

export function SpecialistTaskSourceChip({source,active,onFilter,onOpen,icon}:{
 source:SpecialistTaskSource;active?:boolean;onFilter?:()=>void;onOpen?:()=>void;icon?:ReactNode;
}){
 const content=<>{icon??<TaskSourceIcon kind={source.kind}/>}<span className="specialist-source-label" title={source.label}>{source.label}</span></>;
 return <span className="specialist-source-chip" data-kind={source.kind} data-active={active||undefined}>
  {onFilter?<button type="button" className="specialist-source-name" aria-label={`筛选来源：${source.label}`} aria-pressed={!!active}
   onClick={onFilter}>{content}</button>:<span className="specialist-source-name">{content}</span>}
  {onOpen&&<button type="button" className="specialist-source-open" title={`打开原对话：${source.label}`} aria-label={`打开原对话：${source.label}`}
   onClick={onOpen}><Glyph name="outbound" size={12}/></button>}
 </span>;
}

export function SpecialistTaskList({channel,rows,sources,initialFilters,onTask,onOpenSource,connected=true,loading=false,routing=false,queued=0,error='',onRetry}:{
 channel:SpecialistChannelInfo;rows:SpecialistTaskRow[];sources?:SpecialistTaskSources;initialFilters?:SpecialistTaskFilters;
 onTask:(worker:SuperWorker,filters:SpecialistTaskFilters)=>void;onOpenSource?:OpenSpecialistTaskSource;
 connected?:boolean;loading?:boolean;routing?:boolean;queued?:number;error?:string;onRetry?:()=>void;
}){
 const pageVisible=usePageVisible();
 const surface=useRef<HTMLDivElement>(null);
 const search=useRef<HTMLInputElement>(null);
 const id=useId();
 const [query,setQuery]=useState(initialFilters?.query??'');
 const [selectedSource,setSource]=useState(initialFilters?.source??'all');
 const groups=(sources?.groups??[]).filter(group=>group.projectId===channel.projectId&&group.members.some(member=>member.roleId===channel.roleId&&!member.unavailable))
  .sort((a,b)=>a.title.localeCompare(b.title,'zh-CN')||a.sessionId.localeCompare(b.sessionId));
 const counts=new Map<string,number>();
 const available=new Map(groups.map(group=>{
  const item=groupTaskSource(group);
  return [item.key,item];
 }));
 for(const row of rows){
  available.set(row.source.key,row.source);
  counts.set(row.source.key,(counts.get(row.source.key)??0)+1);
 }
 const tabs=[{key:'all',label:'全部任务',count:rows.length},...[...available.values()]
  .sort((a,b)=>sourceOrder[a.kind]-sourceOrder[b.kind]||a.label.localeCompare(b.label,'zh-CN')||a.key.localeCompare(b.key))
  .map(source=>({key:source.key,label:source.label,count:counts.get(source.key)??0}))];
 const source=available.has(selectedSource)?selectedSource:'all';
 const filters={query,source};
 const visible=filterSpecialistTasks(rows,query,source);
 const filtered=source!=='all'||!!query.trim();
 const reset=()=>{setQuery('');setSource('all');};
 const toggleSource=(key:string)=>setSource(key===source?'all':key);
 const openSource=({sessionId}:SpecialistTaskSource,worker?:SuperWorker)=>sessionId&&onOpenSource
  ? ()=>onOpenSource(sessionId,filters,worker):undefined;
 function moveTab(event:KeyboardEvent<HTMLDivElement>){
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();
  const index=tabs.findIndex(tab=>tab.key===source);
  const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  setSource(tabs[next].key);
  event.currentTarget.querySelectorAll('button')[next]?.focus();
 }
 const moving=connected&&(routing||rows.some(row=>row.moving));
 const defaultAgent=agentTypeName(channel.execution);
 return <div ref={surface} className="specialist-task-page" aria-label={`${channel.roleName}的任务`} data-hidden={!pageVisible||undefined}>
  <header className="specialist-page-heading">
   <div className="specialist-page-identity">
    <span className="specialist-page-avatar"><SuperRoleAvatar name={channel.roleName} roleId={channel.roleId} avatarId={channel.avatarId} size={40} motion={moving?'working':'idle'}/>
     {moving&&<ActivityDots compact label={routing?'正在分配任务':'任务执行中'}/>}
    </span>
    <div className="specialist-page-profile">
     <div className="specialist-page-title"><h1>{channel.roleName}</h1>
      {defaultAgent&&<span className="specialist-task-agent"><AgentBackendLogo backend={channel.execution} size={13}/>{defaultAgent}</span>}
     </div>
     {channel.duties&&<p title={channel.duties}>{channel.duties}</p>}
     {groups.length>0&&<div className="specialist-task-groups" aria-label="所属群组"><span>所属群组</span>{groups.map(group=>{
      const item=groupTaskSource(group);
      return <SpecialistTaskSourceChip key={item.key} source={item} active={source===item.key} icon={<ChatGroupAvatars members={group.members} compact/>}
       onFilter={()=>toggleSource(item.key)} onOpen={openSource(item)}/>;
     })}</div>}
    </div>
   </div>
   <div className="specialist-page-actions"><ConversationReadButton key={channel.sessionId} session={channel.sessionId} state={channel.messageRead} disabled={!connected}/></div>
  </header>
  <ConversationReadMarker session={channel.sessionId} state={channel.messageRead} enabled={connected&&!loading&&!error} surface={surface}/>
  <div className="specialist-task-toolbar">
   <div className="specialist-task-filters" role="tablist" aria-label="任务来源筛选" onKeyDown={moveTab}>
    {tabs.map(tab=><button type="button" key={tab.key} role="tab" id={`${id}-${tab.key}`} aria-selected={source===tab.key}
     aria-label={`${tab.label}，${tab.count} 项任务`} aria-controls={`${id}-results`} tabIndex={source===tab.key?0:-1} title={tab.label} onClick={()=>setSource(tab.key)}>
     <span>{tab.label}</span><small>{tab.count}</small>
    </button>)}
   </div>
   <div className="specialist-task-search"><Glyph name="search" size={15}/><input ref={search} type="search" aria-label="搜索专员任务" placeholder="搜索任务、群聊或资源…" value={query} onChange={event=>setQuery(event.target.value)}/>
    {query&&<button type="button" aria-label="清除搜索" title="清除搜索" onClick={()=>{setQuery('');search.current?.focus();}}><Glyph name="close" size={13}/></button>}
   </div>
  </div>
  {error&&<div className="specialist-page-error" role="alert"><Glyph name="alert" size={14}/><span>{error}</span>{onRetry&&<button type="button" onClick={onRetry}>重新获取</button>}</div>}
  {/* App owns confirmed connection warnings. This flag also pauses actions
      during ordinary navigation and window restoration, without an outage. */}
  {(routing||queued>0)&&<p className="specialist-task-admitting" role="status"><Glyph name={connected?'loader':'clock'} size={13}/>{routing?'正在分配新任务…':`${queued} 项请求等待分配`}</p>}
  <div className="specialist-task-panel" id={`${id}-results`} role="tabpanel" aria-labelledby={`${id}-${source}`} aria-busy={loading}>
   {visible.length>0?<ul className="specialist-task-rows" data-collaborative={rows.some(row=>row.members.length>1)||undefined} aria-label="专员任务列表">{visible.map(row=>{
    const {worker,progress,source:origin}=row;
    const collaborators=row.members.slice(1);
    const names=collaborators.map(member=>member.name).join('、');
    const descriptionId=`${id}-${worker.id}`;
    const updated=specialistTaskTime(row.updatedAt);
    return <li className="specialist-task-record" key={`task:${worker.id}`} data-task-id={worker.task.taskId} data-session-id={worker.sessionId}>
     <div className="specialist-task-start">
      {origin.kind==='lake'||origin.kind==='external'?<>
       <span className="specialist-task-source-icon" data-kind={origin.kind}><TaskSourceIcon kind={origin.kind} size={17}/></span>
       <span className="visually-hidden" id={descriptionId}>参与专员：{row.members.map(member=>member.name).join('、')}</span>
      </>:<TaskSpecialistAvatars members={row.members} descriptionId={descriptionId} connected={connected}/>}
     </div>
     <button type="button" className="specialist-task-open" aria-label={`查看任务：${worker.task.title}`} aria-describedby={descriptionId}
      onClick={()=>onTask(worker,filters)}><strong title={worker.task.title}>{worker.task.title}</strong></button>
     <span className="specialist-task-when">
      {connected&&row.needsConfirmation?<span className="specialist-task-status" data-state="waiting">待确认</span>:connected&&row.moving&&
       <span className="specialist-task-status" data-state="running"><ActivityDots compact/>执行中{progress&&<span role="progressbar"
        aria-label={`${worker.task.title}步骤进度`} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.completed}>{progress.completed}/{progress.total}</span>}</span>}
      {updated!=='—'&&<time dateTime={row.updatedAt} title={new Date(row.updatedAt!).toLocaleString('zh-CN',{hour12:false})}>{updated}</time>}
     </span>
     <div className="specialist-task-meta">
      <SpecialistTaskSourceChip source={origin} active={source===origin.key} onFilter={()=>toggleSource(origin.key)} onOpen={openSource(origin,worker)}/>
      {!!collaborators.length&&<span className="specialist-task-collaborators" title={names}>协作 {collaborators.slice(0,2).map(member=>
       <span className="specialist-task-collaborator" key={member.key}><SuperRoleAvatar roleId={member.roleId} name={member.name} size={15} motion="still"/><span>{member.name}</span></span>)}
       {collaborators.length>2&&<small>+{collaborators.length-2}</small>}
      </span>}
      <span className="specialist-task-agent"><ExecutionAgentIcon agent={worker.execution?.backend.kind==='acp'?worker.execution.backend.agent:undefined} size={12}/>{row.agent}</span>
      {row.preview&&<span className="specialist-task-context" title={row.preview}>{row.preview}</span>}
     </div>
     <span className="specialist-task-chevron"><Glyph name="next" size={14}/></span>
    </li>;
   })}</ul>:<div className="specialist-tasks-empty"><Glyph name={filtered?'search':'layers'} size={26}/><h2>{loading?'正在读取任务…':filtered?'没有匹配的任务':'还没有任务'}</h2><p>{loading?'正在获取这位专员的任务记录。':filtered?'试试调整来源筛选，或搜索任务名称、群聊和资源。':'由 Lake 派发任务，进展和结果会显示在这里。'}</p>{filtered&&<button type="button" className="button secondary" onClick={reset}>查看全部任务</button>}</div>}
   {visible.length>0&&filtered&&<div className="specialist-task-list-count"><span role="status">已显示 {visible.length} 项任务，共 {rows.length} 项</span><button type="button" onClick={reset}>查看全部</button></div>}
  </div>
 </div>;
}
