import type {ScheduledTask} from '../../shared/contracts';
export const scheduleStatus=(status:string)=>({scheduled:'等待执行',running:'执行中',completed:'已完成',failed:'失败',interrupted:'已中断',missed:'已跳过',cancelled:'已停止',waiting_approval:'等待确认'}[status]??'状态待核查');
export function scheduleFrequency(seconds:number){if(!seconds)return '单次';if(seconds%86400===0)return `每 ${seconds/86400} 天`;if(seconds%3600===0)return `每 ${seconds/3600} 小时`;if(seconds%60===0)return `每 ${seconds/60} 分钟`;return `每 ${seconds} 秒`}
export function scheduleTime(value?:string){if(!value)return '—';const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleString('zh-CN',{hour12:false}):'时间待核查'}
export const scheduleEnabledLabel=(row:ScheduledTask)=>row.enabled?'已启用':!row.interval_seconds&&row.status==='completed'?'已结束':'已暂停';
export function scheduleNext(row:ScheduledTask){return row.enabled?scheduleTime(row.at):row.status==='running'?'后续已暂停，本次继续执行':!row.interval_seconds&&row.status==='completed'?'已结束':'已暂停'}
