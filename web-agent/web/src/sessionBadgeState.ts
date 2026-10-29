import type {WorkSession} from '../../shared/contracts';
import type {GlyphName} from './Icons';

// These are presentation states, not new persisted session or task statuses.
const badges = {
 idle:{label:'待命',icon:'clock',tone:'neutral'},
 working:{label:'处理中',icon:'loader',tone:'active'},
 approval:{label:'待确认',icon:'shield',tone:'attention'},
 paused:{label:'已暂停',icon:'pause',tone:'neutral'},
 stopped:{label:'已停止',icon:'stop',tone:'neutral'},
 ended:{label:'已结束',icon:'check',tone:'success'},
 attention:{label:'需关注',icon:'alert',tone:'danger'},
} as const satisfies Record<string,{label:string;icon:GlyphName;tone:string}>;

export function sessionBadgeState(status:WorkSession['status'],detail?:string) {
 // A still-dispatched operation or a fresh approval always owns the live state.
 if(status==='investigating')return {state:'working',...badges.working};
 if(status==='waiting_approval')return {state:'approval',...badges.approval};
 if(detail==='任务已暂停'||detail==='任务待继续')return {state:'paused',...badges.paused};
 if(detail==='任务已取消')return {state:'stopped',...badges.stopped};
 if(detail==='变更待核实'||detail==='调查结束 · 结论不充分')return {state:'attention',...badges.attention,tone:'attention'};
 const state=status==='completed'?'ended':status==='failed'?'attention':'idle';
 return {state,...badges[state]};
}
