import type {AICard,SessionSnapshot} from '../../shared/contracts';
import type {AgentBackendRef} from '../../shared/external-agents';

const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'?value as Record<string,unknown>:{};
const rootOf=(data:Record<string,unknown>)=>typeof data.root_turn_id==='string'&&data.root_turn_id.trim()?data.root_turn_id:undefined;
const childRecord=(data:Record<string,unknown>)=>data.agentRunId!=null||data.childSessionId!=null;

/** Saved native prose belongs to the task's audit view, never its public report.
 * Task snapshots can rewrite ai.rootTurnId to the origin. Real card roots and
 * exact execution IDs preserve all attempts without borrowing another task. */
export function workerProcessRecords(snapshot:SessionSnapshot,backend:AgentBackendRef|undefined=snapshot.superagent?.execution?.backend):AICard[]{
 const task=snapshot.superagent?.task;
 if(!task||task.sessionId!==snapshot.session.id||task.projectId&&task.projectId!==snapshot.session.projectId||backend?.kind==='acp')return [];
 const executionId=task.executionGoalId??task.taskId,cards=snapshot.ai?.cards??[];
 const roots=new Set(cards.flatMap(card=>{
  const data=record(card.data),root=rootOf(data);
  return !childRecord(data)&&data.taskId===executionId&&root?[root]:[];
 }));
 const belongs=(data:Record<string,unknown>)=>{
  if(childRecord(data))return false;
  if(data.taskId!=null&&data.taskId!=='')return data.taskId===executionId;
  const root=rootOf(data);return !!root&&roots.has(root);
 };
 // A legacy snapshot may omit its execution binding. ACP's cumulative record
 // still proves which roots must stay in the existing external-run disclosure.
 const externalRoots=new Set(cards.flatMap(card=>{
  const data=record(card.data),root=rootOf(data);
  return card.type==='operation'&&data.source==='external_agent'&&belongs(data)&&root?[root]:[];
 }));
 const saved=new Map<string,AICard>();
 for(const card of cards){
  if(!['thinking','message','text'].includes(card.type)||!card.content?.trim()||!card.id)continue;
  const data=record(card.data),root=rootOf(data);
  if(!belongs(data)||data.source==='external_agent'||data.external_run_id!=null||root&&externalRoots.has(root))continue;
  saved.set(card.id,card);
 }
 return [...saved.values()];
}
