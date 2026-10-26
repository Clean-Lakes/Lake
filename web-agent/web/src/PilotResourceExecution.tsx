import type {AgentRun,Resource,SessionSnapshot,SREStepAttempt,SRETask} from '../../shared/contracts';
import {ThinkingTimeline} from './ThinkingTimeline';
import {hasMultipleMiniResources,type MiniBoxScope} from './miniBoxModel';
import {pilotCommandScope,pilotExecutionGroups} from './pilotExecutionModel';

export function PilotResourceExecution({task,attempt,snapshot,run,active,connected=true}:{task:SRETask;attempt:SREStepAttempt;snapshot:SessionSnapshot;run?:AgentRun;active:boolean;connected?:boolean}){
 const resources=(snapshot.resources??[]).filter(r=>!r.projectId||r.projectId===snapshot.session.projectId) as Resource[];
 const groups=pilotExecutionGroups(attempt,resources);
 const currentRun=task.runs?.at(-1)?.id;
 const taskGroups=(task.attempts??[]).filter(a=>a.planRunId===currentRun).flatMap(a=>pilotExecutionGroups(a,resources));
 const scope:MiniBoxScope={session:task.sessionId,terminals:snapshot.terminals??[],startedAt:attempt.startedAt,endedAt:attempt.finishedAt,live:active,waiting:!!run?.question||!!run?.pending,connected,multiResource:hasMultipleMiniResources(taskGroups),commandScope:pilotCommandScope(task,attempt)};
 const lastId=attempt.operations?.at(-1)?.id;
 const tail=groups.find(group=>group.entries.some(entry=>entry.id===`pilot-operation-${lastId}`));
 if(!groups.length)return null;
 return <div className="pilot-resource-execution" aria-label="按资源分类的专员执行过程">{groups.map(group=><ThinkingTimeline key={group.entries[0]!.id} cards={group.entries.flatMap(e=>e.card?[e.card]:[])} resource={group.resource} resourceRow miniScope={scope} live={active&&(group===tail||group.entries.some(e=>e.card?.status==='running'))} continuing={active&&group===tail}/>)}</div>;
}
