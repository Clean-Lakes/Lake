import type {SuperTask,SuperWorker} from '../../shared/contracts';
import type {AgentIconName} from './AgentIcon';

// Appearance only: names never select tools, permissions or runtime roles.
// Keep the shape stable when a worker's task or execution state changes.
export function superWorkerIcon(worker:Pick<SuperWorker,'roleName'>):AgentIconName {
 const name=worker.roleName.toLowerCase();
 if(/协调|统筹|规划|coordinator|planner/.test(name))return 'coordinator';
 if(/验收|验证|测试|复核|审查|审核|verif|review|test|audit/.test(name))return 'verifier';
 if(/执行|修复|开发|部署|构建|实施|executor|implement|develop|deploy|build|repair/.test(name))return 'executor';
 return 'investigator';
}

const labels:Record<SuperTask['state'],string>={queued:'排队中',running:'执行中',waiting_external:'等待外部结果',waiting_user:'需要你回答',paused:'已暂停',blocked:'待核实',completed:'执行结束',failed:'执行失败',cancelled:'已停止跟进'};
export function superTaskPresentation(task:Pick<SuperTask,'state'|'acceptanceState'>):{label:string;tone:'active'|'attention'|'danger'|'neutral'|'success'} {
 if(task.state==='completed')return task.acceptanceState==='pass'?{label:'已验收',tone:'success'}:{label:task.acceptanceState==='fail'?'验收未通过':'待验收',tone:'attention'};
 const tone=task.state==='running'||task.state==='waiting_external'?'active':task.state==='waiting_user'||task.state==='blocked'?'attention':task.state==='failed'?'danger':'neutral';
 return {label:labels[task.state]??'待核实',tone};
}

// A restored invocation can have ended while its canonical task is paused.
export function superTaskHeaderPresentation(task?:SuperTask) {
 if(task?.state==='blocked'&&task.reason==='token_limit_removed')return {status:'failed' as const,label:'等待后续核对'};
 return task?.state==='paused'?{status:'completed' as const,label:'任务已暂停'}:undefined;
}
