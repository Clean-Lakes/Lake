import type {AICard,Resource,ResourceTreeNode,SessionSnapshot,SpecialistChannelEntry,SuperWorker} from '../../shared/contracts';
import {agentBackendName} from '../../shared/external-agents';
import {turnTodos} from './TaskProgress';

export type SpecialistTaskRow={worker:SuperWorker;moving:boolean;paths:string[];agent:string;updatedAt?:string;progress?:{completed:number;total:number}};
const time=(value?:string)=>Date.parse(value??'')||0;

export function specialistTaskSteps(snapshot:SessionSnapshot){
 const task=snapshot.superagent?.task;
 if(!task||task.sessionId!==snapshot.session.id)return [];
 const todos=turnTodos(snapshot.ai?.cards??[],task.executionGoalId??task.taskId);
 return todos.length?todos.map((todo,index)=>({id:`todo-${index}`,title:todo.content,status:todo.status==='in_progress'?'running':todo.status})):(snapshot.superagent?.goal?.items??[]);
}

/** Display metadata from the same project, never an asset identity or permission. */
export function specialistResourcePaths(projectId:string,resources:Resource[],tree:ResourceTreeNode[]=[]){
 const nodes=new Map(tree.filter(node=>node.projectId===projectId).map(node=>[node.id,node]));
 const leaves=new Map([...nodes.values()].filter(node=>node.kind==='resource').map(node=>[node.resourceId,node]));
 return new Map(resources.filter(resource=>resource.projectId===projectId).map(resource=>{
  const parts=[resource.name],seen=new Set<string>();let parent=leaves.get(resource.id)?.parentId;
  while(parent){
   const folder=nodes.get(parent);
   if(!folder||folder.kind!=='folder'||seen.has(parent)||seen.size>=32)return [resource.id,resource.name];
   seen.add(parent);parts.unshift(folder.name);parent=folder.parentId;
  }
  return [resource.id,parts.join(' / ')];
 }));
}

export function specialistTaskRows({workers,entries=[],active=[],resources,resourceTree=[],projectId}:{workers:SuperWorker[];entries?:SpecialistChannelEntry[];active?:SessionSnapshot[];resources:Resource[];resourceTree?:ResourceTreeNode[];projectId:string}):SpecialistTaskRow[]{
 const paths=specialistResourcePaths(projectId,resources,resourceTree);
 return workers.filter(worker=>!worker.task.projectId||worker.task.projectId===projectId).map(worker=>{
  const snapshot=active.find(item=>item.session.id===worker.sessionId&&item.session.projectId===projectId&&item.superagent?.task.taskId===worker.task.taskId);
  const history=entries.filter(entry=>entry.sourceSessionId===worker.sessionId&&(!entry.taskId||entry.taskId===worker.task.taskId));
  const cards=new Map<string,AICard>();
  for(const card of [...history.flatMap(entry=>entry.card?[entry.card]:[]),...snapshot?.ai?.cards??[]])cards.set(card.id,card);
  const recorded=[...cards.values()].sort((a,b)=>time(a.at)-time(b.at));
  const todos=turnTodos(recorded,worker.task.executionGoalId??worker.task.taskId);
  const items=snapshot?.superagent?.goal?.items??[];
  const progress=todos.length?{completed:todos.filter(todo=>todo.status==='completed').length,total:todos.length}:items.length?{completed:items.filter(item=>item.status==='completed').length,total:items.length}:undefined;
  const terminal=['completed','failed','cancelled'].includes(worker.task.state);
  const waiting=!terminal&&(!!snapshot?.ai?.question||!!snapshot?.ai?.pending||!!snapshot?.hostKeyTrust||['waiting_approval','waiting_input'].includes(worker.activity?.phase??''));
  const moving=!waiting&&!terminal&&(snapshot?.ai?.status==='running'||worker.task.state==='running');
  const ids=new Set((worker.task.resources??[]).flatMap(resource=>resource.assetRef?[resource.assetRef]:[]));
  for(const card of recorded){const data=card.data as {resource_id?:string;taskId?:string}|undefined;if(data?.resource_id&&data.taskId===(worker.task.executionGoalId??worker.task.taskId))ids.add(data.resource_id);}
  const updated=[worker.task.updatedAt,worker.createdAt,...history.map(entry=>entry.createdAt),...(worker.execution?.runs??[]).map(run=>run.updatedAt)].filter((value):value is string=>!!value&&!!time(value)).sort((a,b)=>time(b)-time(a))[0];
  return {worker,moving,paths:[...ids].flatMap(id=>paths.has(id)?[paths.get(id)!]:[]),agent:agentBackendName(worker.execution?.backend??{kind:'native'}),updatedAt:updated,progress};
 }).sort((a,b)=>{
  // Keep task positions stable during streaming; new assignments enter first.
  return time(b.worker.createdAt)-time(a.worker.createdAt)||b.worker.id.localeCompare(a.worker.id);
 });
}

export function filterSpecialistTasks(rows:SpecialistTaskRow[],query:string){
 const normalized=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/\s*\/\s*/g,'/');
 const search=normalized(query.trim());
 return rows.filter(row=>!search||[row.worker.task.title,...row.paths,row.agent].some(value=>normalized(value).includes(search)));
}

export function specialistTaskTime(value?:string,now=Date.now()){
 const at=time(value);if(!at)return '—';
 const age=now-at;
 if(age>=0&&age<60_000)return '刚刚';
 if(age>=60_000&&age<3600_000)return `${Math.floor(age/60_000)} 分钟前`;
 const date=new Date(at),today=new Date(now);
 return date.toLocaleDateString('zh-CN')===today.toLocaleDateString('zh-CN')?date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):date.toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'});
}
