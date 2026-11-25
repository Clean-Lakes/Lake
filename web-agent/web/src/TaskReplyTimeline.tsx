import type {ReactNode} from 'react';
import type {SpecialistStep,SpecialistTimeline} from '../../shared/specialist-timeline';
import {StatusText} from './StatusText';

const clock = new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const labels:Record<string,string> = {
  completed:'已结束',success:'已结束',succeeded:'已结束',failed:'失败',unknown:'待核实',
  pending:'待确认',waiting_approval:'待确认',cancelled:'已停止',interrupted:'已中断',
  not_executed:'未执行',queued:'排队中',declined:'已拒绝',
};

function StepTime({at,startedAt}:{at:string;startedAt?:string}) {
  const end=Date.parse(at), start=Date.parse(startedAt ?? '');
  if (!Number.isFinite(end)) return null;
  const seconds=Math.floor((end-start)/1000);
  const relative=Number.isFinite(seconds) && seconds>=0;
  const text=relative ? String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0') : clock.format(end);
  return <time dateTime={at} title={new Date(end).toLocaleString()} aria-label={relative?`开始后 ${Math.floor(seconds/60)} 分 ${seconds%60} 秒`:undefined}>{text}</time>;
}

export function TaskReplyTimeline({timeline,active=false,reportAt,children}:{timeline?:SpecialistTimeline;active?:boolean;reportAt?:string;children:ReactNode}) {
  const steps=timeline?.steps ?? [];
  const split=Math.max(0,steps.length-4);
  function step(item:SpecialistStep) {
    const running=item.status==='running'||item.status==='background_running';
    const state=running ? (reportAt?'未记录结束':'进行中') : (labels[item.status] ?? '待核实');
    return <li key={item.id} className="task-reply-event" data-state={item.status}>
      <StepTime at={item.at} startedAt={timeline?.startedAt}/><i aria-hidden="true"/>
      <div><StatusText active={active && running}>{item.label}</StatusText><small>{state}</small></div>
    </li>;
  }
  return <div className="task-reply-timeline" data-steps={steps.length>0||undefined}>
    {split>0&&<details className="task-reply-earlier"><summary>更早的 {split} 个步骤</summary><ol>{steps.slice(0,split).map(step)}</ol></details>}
    {steps.length>0&&<ol aria-label="任务时间线">{steps.slice(split).map(step)}</ol>}
    <div className="task-reply-tail" data-report={steps.length>0&&!!reportAt||undefined}>
      {steps.length>0&&reportAt&&<><StepTime at={reportAt} startedAt={timeline?.startedAt}/><i aria-hidden="true"/></>}
      <div className="task-reply-prose">{children}</div>
    </div>
  </div>;
}
