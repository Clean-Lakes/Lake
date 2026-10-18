import type {SRETask,WorkSession} from '../../shared/contracts';
import {sreNeedsVerification} from './sreOperationPolicy';
export function sreSessionPresentation(session:WorkSession,tasks:SRETask[]=[]):{label?:string;status?:WorkSession['status']}{
 if(session.status==='investigating'||session.status==='waiting_approval')return {};
 const t=tasks.find(t=>['draft','active','paused','waiting_input','waiting_approval'].includes(t.status))??tasks[0];
 if(!t)return {};
 if(t.attempts?.some(a=>a.operations?.some(sreNeedsVerification)))return {label:'变更待核实',status:'failed'};
 if(t.attempts?.some(a=>a.operations?.some(op=>op.status==='dispatched')))return {label:'原操作仍在执行',status:'investigating'};
 if(t.status==='paused')return {label:'任务已暂停',status:'failed'};
 if(t.status==='waiting_input'||t.status==='draft')return {label:'任务待继续',status:'failed'};
 if(t.status==='failed')return {label:'任务未完成',status:'failed'};
 if(t.status==='cancelled')return {label:'任务已取消',status:'failed'};
 if(t.status==='completed')return t.outcome==='inconclusive'?{label:'调查结束 · 结论不充分',status:'failed'}:{label:'任务已完成'};
 return {};
}
