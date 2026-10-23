import type {ProjectMemoryEntry,ProjectMemoryList,MemoryKnowledgeKind,ProjectMemoryJob} from '../../shared/contracts';

export type MemoryViewState={projectId:string;sequence:number;list:ProjectMemoryList|null;error:string};
export type MemoryViewAction={type:'request';projectId:string;sequence:number}|{type:'loaded';projectId:string;sequence:number;list:ProjectMemoryList}|{type:'failed';projectId:string;sequence:number;error:string};
export function reduceMemoryView(state:MemoryViewState,action:MemoryViewAction):MemoryViewState {
 if(action.type==='request')return {projectId:action.projectId,sequence:action.sequence,list:state.projectId===action.projectId?state.list:null,error:''};
 if(action.projectId!==state.projectId||action.sequence!==state.sequence)return state;
 return action.type==='loaded'?{...state,list:action.list,error:''}:{...state,error:action.error};
}
export const knowledgeLabels:Record<MemoryKnowledgeKind,string>={preference:'偏好',procedure:'方法',topology:'拓扑',configuration:'配置',incident_lesson:'事故经验'};
export const eligibilityLabels:Record<string,string>={eligible:'范围匹配',needs_review:'待复核',conflict:'存在冲突',disabled:'已停用',missing_resource:'资源已归档或不存在',generation_mismatch:'连接已变化',expired:'已过期',deleted:'已遗忘'};
export function memoryTime(at?:string){return at&&!Number.isNaN(Date.parse(at))?new Date(at).toLocaleString():'未记录';}
export type MemoryDraft={key:string;type:ProjectMemoryEntry['type'];description:string;body:string;revision:number;validUntil:string;restoreDeleted:boolean;knowledgeKind:MemoryKnowledgeKind;scopeKind:'project'|'resources';resourceIds:string[];subject:Record<string,unknown>;factKey:string;alwaysReference:boolean;reviewState:"active"|"disabled"};
export function memoryDraft(entry:Partial<ProjectMemoryEntry>={}):MemoryDraft {
 return {key:entry.key||'',type:entry.type||'project',description:entry.description||'',body:entry.body||'',revision:entry.revision||0,validUntil:entry.validUntil||'',restoreDeleted:!!entry.deletedAt,knowledgeKind:entry.knowledgeKind||'procedure',scopeKind:entry.scopeKind||(entry.key||entry.body?'resources':'project'),resourceIds:entry.resourceIds||[],subject:entry.subject||{},factKey:entry.factKey||entry.key||'',alwaysReference:entry.alwaysReference||false,reviewState:entry.reviewState==='disabled'?'disabled':'active'};
}

export function memoryJobUsage(job:ProjectMemoryJob){if(job.dispatchCount===undefined)return "用量未知";if(!job.dispatchCount)return "尚未派发";return `已派发 ${job.dispatchCount} 次 · ${job.unknownAttempts?`用量未知 ${job.unknownAttempts} 次`:String(job.knownTokens??0)+" token"}`;}

export function memoryJobReason(code:string){return ({daily_dispatch_limit:"当日提炼额度已用完",resource_changed:"资源已变化，需要新证据",model_error:"模型请求失败",model_unavailable:"原模型不可用",invalid_output:"提炼格式不符合要求",credential_detected:"内容包含凭据，未保存",context_budget:"本轮内容超出提炼上限",legacy_or_invalid_snapshot:"旧轮次不支持提炼",legacy_snapshot:"旧轮次不支持提炼",migrated_v2:"迁移前的提炼已停用",foreground_preempted:"前台消息优先，已重新排队",queue_limit:"待处理轮次已满",queue_expired:"旧轮次已超过 7 天",memory_changed:"记忆已修正，旧提炼未应用",memory_disabled:"记忆或提炼已关闭",conflict:"记忆已变化，需重新核对",interrupted:"提炼已中断",shutdown:"服务重启，等待恢复",output_limit:"模型输出超过上限"} as Record<string,string>)[code]||"提炼未完成，请核对任务";}
