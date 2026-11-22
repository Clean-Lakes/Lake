import {useId,useMemo,useState} from 'react';
import type {Message,PilotTaskReference,Resource,SuperWorker,SuperWorkspace,WorkSession} from '../../shared/contracts';
import {Glyph} from './Icons';
import {specialistTaskMembers,specialistTaskTime,type SpecialistTaskMember} from './specialistTaskListModel';
import {superTaskPresentation} from './superAgentPresentation';
import {TaskSpecialistAvatars} from './TaskSpecialistAvatars';

export type PilotTaskDirectoryData = {
 workspace:SuperWorkspace|null;
 session:Pick<WorkSession,'id'|'projectId'>;
 messages:readonly Message[];
 resources:readonly Resource[];
 currentTaskId?:string;
 error?:string;
 onContinue:(task:PilotTaskReference)=>void;
};

export function PilotTaskReferenceChip({task,onClear,compact=false,members=[]}:{
 task:PilotTaskReference;
 onClear?:()=>void;
 compact?:boolean;
 members?:readonly SpecialistTaskMember[];
}){
 const authors=useId();
 return <span className={`pilot-task-reference${onClear?' is-draft':''}${compact?' is-compact':''}`} title={compact?`续接中 · ${task.title}`:task.title}
  role={onClear?'group':undefined} aria-label={onClear?`续接中 · ${task.title}`:undefined} aria-describedby={members.length?authors:undefined}>
  {members.length?<TaskSpecialistAvatars members={members} descriptionId={authors} inline/>:<Glyph name="return" size={13}/>}
  {compact?<span className="pilot-task-reference-status" aria-hidden="true">续接中</span>:
   <>{onClear&&<small>续接</small>}<span className="pilot-task-reference-title">{task.title}</span></>}
  {onClear&&<button type="button" aria-label="移除任务续接" onClick={onClear}><Glyph name="close" size={12}/></button>}
 </span>;
}

type DirectoryTask = PilotTaskReference & {
 sourceMessageId?:string;
 updatedAt?:string;
 label:string;
 summary?:string;
 reports:number;
 members:SpecialistTaskMember[];
 archived:boolean;
 searchText:string;
};

const normalize = (value:string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g,'');

function pilotTaskWorkers(workspace:SuperWorkspace|null,session:PilotTaskDirectoryData['session']){
 if(!workspace?.active||workspace.project.projectId!==session.projectId||workspace.project.routerSessionId!==session.id)return [];
 return workspace.workers.filter(({parentWorkerId,sessionId,task})=>
  !parentWorkerId&&task.sessionId===sessionId&&(!task.projectId||task.projectId===session.projectId));
}

function taskParticipants(workers:readonly SuperWorker[]){
 const participants=new Map<string,SpecialistTaskMember>();
 for(const worker of workers){
  for(const member of specialistTaskMembers(worker,false)){
   if(!participants.has(member.key))participants.set(member.key,{...member,moving:false});
  }
 }
 return [...participants.values()].sort((a,b)=>a.key.localeCompare(b.key));
}

export function pilotTaskParticipants(workspace:SuperWorkspace|null,session:PilotTaskDirectoryData['session'],taskId:string){
 return taskParticipants(pilotTaskWorkers(workspace,session).filter(worker=>worker.task.taskId===taskId));
}

export function pilotDirectoryTasks({workspace,session,messages,resources}:Pick<PilotTaskDirectoryData,'workspace'|'session'|'messages'|'resources'>):DirectoryTask[] {
 const activeWorkers=pilotTaskWorkers(workspace,session);
 if(!activeWorkers.length)return [];
 const groups=new Map<string,SuperWorker[]>();
 for(const worker of activeWorkers){
  const task=worker.task;
  const group=groups.get(task.taskId);
  if(group)group.push(worker);
  else groups.set(task.taskId,[worker]);
 }
 const byMessage=new Map(messages.filter(message=>message.sessionId===session.id).map(message=>[message.id,message]));
 const summaries=new Map<string,Message>();
 for(const message of byMessage.values()){
  const report=message.jointReport;
  if(message.role!=='assistant'||report?.kind!=='summary'||!message.text.trim())continue;
  if(message.createdAt>=(summaries.get(report.taskId)?.createdAt??''))summaries.set(report.taskId,message);
 }
 const byResource=new Map(resources.filter(resource=>resource.projectId===session.projectId).map(resource=>[resource.id,resource.name]));
 const time=(worker:SuperWorker)=>worker.task.updatedAt??worker.createdAt??'';
 return [...groups.entries()].map(([taskId,workers])=>{
  const newest=[...workers].sort((a,b)=>time(b).localeCompare(time(a)));
  const worker=newest[0]!;
  const {task}=worker;
  const reports=new Map<string,Message>();
  const origins:Message[]=[];
  const names=new Set<string>();
  for(const member of workers){
   const report=byMessage.get(member.pilotReport?.messageId??'');
   if(report?.author?.workerId===member.id&&report.author.taskId===taskId)reports.set(report.id,report);
   const source=byMessage.get(member.pilotSourceMessageId??'');
   if(source?.role==='user')origins.push(source);
   for(const resource of member.task.resources??[]){
    const name=byResource.get(resource.assetRef??'');
    if(name)names.add(name);
   }
  }
  const synthesis=summaries.get(taskId);
  const report=[...reports.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  const origin=origins.sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0]??byMessage.get(synthesis?.replyToMessageId??report?.replyToMessageId??'');
  for(const mention of origin?.mentions??[]){
   if(mention.kind==='resource'&&byResource.has(mention.id))names.add(byResource.get(mention.id)!);
  }
  const summary=synthesis?.text.trim()||newest.find(member=>member.task.summary?.trim())?.task.summary?.trim()||report?.text.trim();
  const archived=workers.every(member=>member.assignmentState==='archived');
  const aggregate=task.collaboration??task;
  const label=archived?'历史记录':aggregate.state==='completed'&&workers.some(member=>member.task.reportedOutcome==='partial')?
   '部分完成':superTaskPresentation(aggregate).label;
  const updatedAt=time(worker);
  const date=Date.parse(updatedAt);
  const dateSearch=Number.isFinite(date)?new Date(date).toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric'}):'';
  const members=taskParticipants(workers);
  return {taskId,title:task.title,sourceMessageId:origin?.role==='user'?origin.id:undefined,updatedAt,label,summary,reports:reports.size,members,archived,
   searchText:normalize([task.title,summary,origin?.text,updatedAt,dateSearch,...names,...members.map(member=>member.name)].join(' '))};
 }).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.taskId.localeCompare(b.taskId));
}

export function PilotTaskDirectory({data,onContinue,onLocate,visibleSources}:{
 data:PilotTaskDirectoryData;
 onContinue:(task:PilotTaskReference)=>void;
 onLocate:(sourceId:string)=>void;
 visibleSources:ReadonlySet<string>;
}){
 const [query,setQuery]=useState('');
 const [selection,setSelection]=useState(data.currentTaskId);
 const id=useId();
 const {workspace,session,messages,resources}=data;
 const rows=useMemo(()=>pilotDirectoryTasks({workspace,session,messages,resources}),[workspace,session,messages,resources]);
 const search=normalize(query);
 const results=search?rows.filter(task=>task.searchText.includes(search)):rows;
 const selected=results.find(task=>task.taskId===selection)??results[0];
 const sourceId=selected?.sourceMessageId;
 return <div className="conversation-task-directory">
  <label className="conversation-task-search">
   <Glyph name="search" size={15}/>
   <input type="search" aria-label="搜索任务或资源" placeholder="搜索任务或资源" value={query} onChange={event=>setQuery(event.target.value)}/>
  </label>
  {results.length?<nav className="conversation-directory-list conversation-task-list" aria-label="Pilot 任务">
   {results.map((task,index)=>{
    const authors=`${id}-participants-${index}`;
    return <button type="button" className="conversation-directory-item conversation-task-row" key={task.taskId}
     aria-describedby={authors} aria-pressed={selected?.taskId===task.taskId} title={task.title} onClick={()=>setSelection(task.taskId)}>
     <span className="conversation-task-row-text">
      <span className="conversation-task-title">{task.title}</span>
      <span className="conversation-task-meta">{task.updatedAt&&<>{specialistTaskTime(task.updatedAt)}<span aria-hidden="true"> · </span></>}{task.label}</span>
     </span>
     <TaskSpecialistAvatars members={task.members} descriptionId={authors} inline/>
    </button>;
   })}
  </nav>:<p className="conversation-task-empty" role="status">{data.error?'任务暂未加载':!workspace?'正在读取任务…':search?'没有匹配的任务':'暂无任务'}</p>}
  {selected&&<section className="conversation-task-preview" aria-label={selected.title} aria-live="polite">
   <div className="conversation-task-preview-meta"><span>上次结论</span>{selected.reports>0&&<span>{selected.reports} 份专员报告</span>}</div>
   <p>{selected.summary||'暂无已记录的结论'}</p>
   {(!selected.archived||sourceId&&visibleSources.has(sourceId))&&<footer className="conversation-directory-actions conversation-task-actions">
    {!selected.archived&&<button type="button" className="conversation-task-continue" onClick={()=>onContinue({taskId:selected.taskId,title:selected.title})}>
     <Glyph name="return" size={14}/>接着问
    </button>}
    {sourceId&&visibleSources.has(sourceId)&&<button type="button" onClick={()=>onLocate(sourceId)}>定位原对话</button>}
   </footer>}
  </section>}
 </div>;
}
