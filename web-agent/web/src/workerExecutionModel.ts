import {isNativeAgentSource,isNativeControlSource} from '../../shared/runtime-compat';
import type {AICard,AgentRun,Resource,ResourceTreeNode,SessionSnapshot} from '../../shared/contracts';
import {compareTreeNodes,projectResourceTree} from './resource-tree-model';

const controls=new Set(['Agent','Task','TaskOutput','TaskStop','SendMessage']);
const settled=new Set(['completed','succeeded','success','cancelled','interrupted','not_executed']);
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'?value as Record<string,unknown>:{};
export const nativeControlCard=(card:AICard)=>controls.has(card.title??'')||isNativeControlSource(record(card.data).source);
export const executionCard=(card:AICard)=>['operation','shell','error'].includes(card.type);
export const needsExecutionAttention=(status:string)=>['running','queued','pending','waiting_approval','waiting_input','unknown','failed','background_running'].includes(status);
/** Ending the child model loop cannot resolve an unknown business effect. A
 * later successful sample likewise never erases that original operation. */
export const nativeRunState=(run:AgentRun)=>run.cards?.some(card=>executionCard(card)&&card.status==='unknown')?'unknown':run.status;
export function executionState(states:string[]):string{
 for(const state of ['waiting_approval','waiting_input','pending','unknown','failed','running','background_running','queued'])if(states.includes(state))return state;
 if(states.length&&states.every(state=>['completed','succeeded','success'].includes(state)))return 'completed';
 return states.find(state=>!settled.has(state))??states[0]??'queued';
}
export type WorkerExecutionNode={id:string;name:string;path:string;kind:'folder'|'resource';resource?:Resource;children:WorkerExecutionNode[];runs:AgentRun[];cards:AICard[];state:string};
export type WorkerExecutionModel={resources:WorkerExecutionNode[];taskRuns:AgentRun[];taskCards:AICard[];runs:AgentRun[];resourcePaths:Map<string,string>};

/** A read-only projection of actual task records. Labels and model arguments
 * never establish resource ownership or create another child execution. */
export function workerExecutionModel(snapshot:SessionSnapshot):WorkerExecutionModel{
 const task=snapshot.superagent?.task;
 const result:WorkerExecutionModel={resources:[],taskRuns:[],taskCards:[],runs:[],resourcePaths:new Map()};
 if(!task||task.sessionId!==snapshot.session.id)return result;
 const executionId=task.executionGoalId??task.taskId;
 const catalog=snapshot.resources.filter(resource=>resource.projectId===snapshot.session.projectId);
 const byResource=new Map<string,Resource>();
 const ambiguous=new Set<string>();
 for(const resource of catalog){if(byResource.has(resource.id))ambiguous.add(resource.id);else byResource.set(resource.id,resource)}
 for(const id of ambiguous)byResource.delete(id);
 const raw=projectResourceTree(snapshot.session.projectId,snapshot.resourceTree??[],catalog);
 const ownerNodes=new Map<string,ResourceTreeNode>();
 for(const node of [...raw].sort(compareTreeNodes))if(node.kind==='resource'&&node.resourceId&&byResource.has(node.resourceId)&&!ownerNodes.has(node.resourceId))ownerNodes.set(node.resourceId,node);
 const resourceRuns=new Map<string,AgentRun[]>(),resourceCards=new Map<string,AICard[]>();
 const taskCards=(snapshot.ai?.cards??[]).filter(card=>{
  if(!executionCard(card))return false;
  const data=record(card.data);
  return (!data.taskId||data.taskId===executionId)&&!data.agentRunId&&(!nativeControlCard(card)||['failed','unknown'].includes(card.status));
 });
 for(const card of taskCards){
  const resourceId=record(card.data).resource_id;
  if(typeof resourceId==='string'&&byResource.has(resourceId))resourceCards.set(resourceId,[...(resourceCards.get(resourceId)??[]),card]);
  else result.taskCards.push(card);
 }
 const unique=new Map<string,AgentRun>();
 for(const run of snapshot.ai?.agentRuns??[])if(isNativeAgentSource(run.source)&&run.taskId===executionId&&run.childSessionId&&run.id)unique.set(run.id,run);
 result.runs=[...unique.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
 for(const run of result.runs){
  const ids=[...new Set(run.resourceIds)];
  const cardIds=(run.cards??[]).map(card=>record(card.data).resource_id).filter((id):id is string=>typeof id==='string'&&!!id);
  const resourceId=ids.length===1?ids[0]:undefined;
  if(resourceId&&byResource.has(resourceId)&&cardIds.every(id=>id===resourceId))resourceRuns.set(resourceId,[...(resourceRuns.get(resourceId)??[]),run]);
  else result.taskRuns.push(run);
 }
 const used=new Set([...resourceRuns.keys(),...resourceCards.keys()]);
 // Cross-resource calls retain exact resource identities while displaying only names.
 for(const [resourceId] of ownerNodes)result.resourcePaths.set(resourceId,byResource.get(resourceId)!.name);
 for(const [resourceId,node] of ownerNodes){
  if(!used.has(resourceId))continue;
  const resource=byResource.get(resourceId)!;
  const runs=resourceRuns.get(resourceId)??[],cards=resourceCards.get(resourceId)??[];
  result.resources.push({id:node.id,name:resource.name,path:resource.name,kind:'resource',resource,children:[],runs,cards,state:executionState([...runs.map(nativeRunState),...cards.map(card=>card.status)])});
 }
 return result;
}

/** Receipt identity comes only from the host's canonical operation ledger
 * projection. A tool label, success status or model argument is not evidence. */
export function workerBusinessReceipts(snapshot:SessionSnapshot):AICard[]{
 const task=snapshot.superagent?.task;
 if(!task||task.sessionId!==snapshot.session.id)return [];
 const executionId=task.executionGoalId??task.taskId;
 const model=workerExecutionModel(snapshot);
 const ownCards=(nodes:WorkerExecutionNode[]):AICard[]=>nodes.flatMap(node=>[...node.cards,...ownCards(node.children)]);
 const candidates=[...model.taskCards,...ownCards(model.resources),...model.runs.flatMap(run=>run.cards??[])];
 const receipts=new Map<string,AICard>();
 for(const card of candidates){
  if(!executionCard(card)||nativeControlCard(card))continue;
  const data=record(card.data),operationId=data.operation_id;
  if(data.taskId!==executionId||typeof operationId!=='string'||!operationId.trim())continue;
  const previous=receipts.get(operationId);
  if(!previous||card.status==='unknown'||previous.status!=='unknown')receipts.set(operationId,card);
 }
 return [...receipts.values()];
}
