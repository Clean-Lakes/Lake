import type {AIView} from '../../shared/contracts';
import type {TranscriptEntry} from './timeline';
import type {ConversationGroup} from './conversation-progress-model';
import type {ResourceStages} from './resourceStageProgress';
import {toolDescription} from './activity';

export type OverallProgress={facts:string;activity:string;latest?:TranscriptEntry};
/** Current-turn facts provide the refresh revision and an honest loading fallback.
 * Semantic synthesis is generated separately; these records are never quoted below. */
export function overallProgressSummary(turn:TranscriptEntry[],groups:ConversationGroup[],stages:ResourceStages,view?:AIView):OverallProgress|undefined {
 const resources=groups.filter(group=>group.progress&&group.resource);
 if(!resources.length||turn.some(entry=>entry.agentRun||entry.sre))return;
 const tools=[...new Map(turn.flatMap(entry=>entry.card&&['operation','shell'].includes(entry.card.type)?[[entry.card.id,entry.card] as const]:[])).values()];
 if(!tools.length)return;
 const completed=tools.filter(card=>['completed','succeeded','success'].includes(card.status)).length;
 const stopped=tools.filter(card=>['cancelled','interrupted'].includes(card.status)).length;
 const facts=[`本轮涉及 ${resources.length} 个资源`,`已完成 ${completed} 项操作`,...[
  ['failed','失败'],['not_executed','未执行'],['unknown','结果待核查'],['background_running','后台执行中'],
 ].flatMap(([status,label])=>{const count=tools.filter(card=>card.status===status).length;return count?[`${count} 项${label}`]:[];}),...(stopped?[`${stopped} 项已停止`]:[])].join('，')+'。';
 const current=tools.filter(card=>card.status==='running').at(-1);
 const pending=tools.some(card=>card.status==='pending');
 const activity=view?.question?'等待你的选择。':pending||view?.status==='waiting_approval'?'等待确认后继续。':current?`当前正在${toolDescription(current)}。`:tools.some(card=>card.status==='unknown')?'当前有执行结果待核查。':tools.some(card=>card.status==='background_running')?'后台命令仍在运行。':'正在根据已返回结果思考下一步。';
 // A resource stage is also an overall milestone. Deduplicate joint results by
 // original entry ID, and never let an initial pre-tool plan replace newer facts.
 const milestones=new Set([...stages.byResource.values()].flatMap(entries=>entries.at(-1)?[entries.at(-1)!.id]:[]));
 let lastTool=-1;turn.forEach((entry,index)=>{if(entry.card&&['operation','shell'].includes(entry.card.type))lastTool=index;});
 const narration=new Set(stages.overall.map(entry=>entry.id));
 const latest=turn.filter((entry,index)=>milestones.has(entry.id)||index>lastTool&&narration.has(entry.id)).at(-1);
 return {facts,activity,latest};
}
