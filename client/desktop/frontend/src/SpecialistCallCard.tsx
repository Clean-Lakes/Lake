import { useState } from 'react'
import { Activity, Check, ChevronDown, Code2, LoaderCircle, Sparkles, SquareTerminal, X } from 'lucide-react'
import { AgentDisclosure } from './components/beui/agent-disclosure'
import { DownloadButton } from './shared/DownloadButton'
import { workflowTraceSummary, workflowStepMessage } from './workflowTrace'
import { workflowWaitLabel, type WorkflowPlanning } from './workflowPlanning'

export type SpecialistCall = {
  id: string
  kind: 'ssh' | 'code' | 'workflow' | 'specialist'
  name?: string
  task: string
  stage: 'delegated' | 'working' | 'returned' | 'completed' | 'failed'
  run_id?: string
  completed?: number
  total?: number
  planning?: WorkflowPlanning
  steps?: { id: string; name: string; resource: string; kind: string; status: string; message?: string }[]
}

const stageLabel: Record<SpecialistCall['stage'], string> = {
  delegated: '已委派',
  working: '处理中',
  returned: '整理中',
  completed: '已汇总',
  failed: '已中断',
}

export function SpecialistCallCard({ call }: { call: SpecialistCall }) {
  const [open, setOpen] = useState(call.kind !== 'workflow')
  if (call.kind === 'workflow') return <WorkflowCallCard call={call} open={open} setOpen={setOpen} />
  const specialist = call.kind === 'specialist' ? `${call.name ?? '自定义'} 专员` : call.kind === 'ssh' ? 'SSH 专员' : '代码专员'
  const returned = call.stage === 'returned' || call.stage === 'completed'
  const working = call.stage === 'working'
  const finished = call.stage === 'completed' || call.stage === 'failed'

  return <div className={'specialist-card ' + (finished ? 'finished' : '')}>
    <button type="button" className="specialist-head" aria-expanded={open} aria-label={`${specialist}：${call.task}，${stageLabel[call.stage]}，${open ? '收起' : '展开'}步骤`} onClick={() => setOpen(previous => !previous)}>
      <span className="specialist-icon" aria-hidden="true">{call.kind === 'ssh' ? <SquareTerminal size={15} /> : <Code2 size={15} />}</span>
      <span className="specialist-title"><strong>{specialist}</strong><span>· {call.task}</span></span>
      <span className={'specialist-status ' + call.stage}>{call.stage === 'completed' ? <Check size={14} /> : call.stage === 'failed' ? <X size={14} /> : <LoaderCircle className="spin" size={14} />}{stageLabel[call.stage]}</span>
      <ChevronDown className={'specialist-chevron ' + (open ? 'open' : '')} size={15} />
    </button>
    <AgentDisclosure open={open} className="specialist-disclosure">
      <ol className="specialist-steps">
        <li className="done"><span className="specialist-step-marker" /><div><strong>Lake Agent</strong><p>已委派请求</p></div></li>
        <li className={returned ? 'done' : call.stage === 'failed' ? 'failed' : working ? 'current' : 'pending'}><span className="specialist-step-marker" /><div><strong>{specialist}</strong><p>{call.stage === 'delegated' ? '等待开始' : call.stage === 'working' ? call.task : call.stage === 'failed' ? '调用中断' : '已交回处理结果'}</p></div></li>
        <li className={call.stage === 'completed' ? 'done' : call.stage === 'returned' ? 'current' : 'pending'}><span className="specialist-step-marker" /><div><strong>Lake Agent</strong><p>{call.stage === 'completed' ? '已整理回复' : call.stage === 'returned' ? '正在整理回复' : '等待专员结果'}</p></div></li>
      </ol>
      {finished && <DownloadButton className="specialist-download" filename={`lake-${call.kind}-${call.id}.json`} mimeType="application/json" content={JSON.stringify(call, null, 2)}>下载专员工具结果摘要</DownloadButton>}
    </AgentDisclosure>
  </div>
}

const workflowStatus: Record<string, string> = { pending: '等待', running: '执行中', waiting_approval: '等待审批', completed: '完成', failed: '失败', skipped: '跳过', cancelled: '已取消', unknown: '结果未知' }

function WorkflowCallCard({ call, open, setOpen }: { call: SpecialistCall; open: boolean; setOpen: (value: boolean) => void }) {
  const finished = call.stage === 'completed' || call.stage === 'failed'
  const summary = workflowTraceSummary(call)
  return <div className={'specialist-card workflow-trace ' + (finished ? 'finished' : '')}>
    <button type="button" className="specialist-head" aria-expanded={open} aria-label={`运维工作流：${call.task}，${summary}，${open ? '收起' : '展开'}执行轨迹`} onClick={() => setOpen(!open)}>
      <span className="specialist-icon" aria-hidden="true"><Activity size={15} /></span>
      <span className="specialist-title"><strong>工作流</strong><span>· {call.task}</span></span>
      <span className={'specialist-status ' + call.stage}>{call.stage === 'completed' ? <Check size={14} /> : call.stage === 'failed' ? <X size={14} /> : <LoaderCircle className="spin" size={14} />}{summary}</span>
      <ChevronDown className={'specialist-chevron ' + (open ? 'open' : '')} size={15} />
    </button>
    {call.planning && call.planning.status !== 'unchanged' && <details className={'workflow-planning ' + call.planning.status}>
      <summary><Sparkles size={13} aria-hidden="true" /><span>{call.planning.message}</span><ChevronDown size={13} aria-hidden="true" /></summary>
      <div className="workflow-planning-changes">{(call.planning.adjustments ?? []).map(change => <div key={change.step_id}>
        <strong>{change.step_name}</strong>
        {change.timeout_seconds !== change.timeout_before_seconds && <span className="workflow-planning-time">等待 {workflowWaitLabel(change.timeout_before_seconds)} → {workflowWaitLabel(change.timeout_seconds)}</span>}
        {!!change.wait_for?.length && <span className="workflow-planning-wait">待{change.wait_for.map(name => `“${name}”`).join('、')}完成后执行</span>}
        <p>{change.reason}</p>
      </div>)}</div>
    </details>}
    <AgentDisclosure open={open} className="specialist-disclosure">
      <ol className="specialist-steps">
        <li className="done"><span className="specialist-step-marker" /><div><strong>Lake Agent</strong><p>已调用工作流执行器</p></div></li>
        <li className={finished ? call.stage === 'failed' ? 'failed' : 'done' : 'current'}><span className="specialist-step-marker" /><div><strong>工作流执行器</strong><p>调度步骤与专员，记录执行和验证结果</p></div></li>
      </ol>
      <div className="workflow-trace-steps">{(call.steps ?? []).map(step => <div className={'workflow-trace-step ' + step.status} key={step.id}><span className="workflow-trace-dot" /><span className="workflow-trace-detail"><strong>{step.name || step.id}</strong><small title={step.message}>{step.resource} · {step.kind === 'ssh_check' ? 'SSH 巡检' : step.kind === 'ssh_command' ? 'SSH 命令' : step.kind === 'ssh_task' ? '模型专员目标任务' : step.kind}{step.message ? ` · ${workflowStepMessage(step)}` : ''}</small></span><em>{workflowStatus[step.status] ?? step.status}</em></div>)}</div>
      <ol className="specialist-steps workflow-trace-return"><li className={finished ? 'done' : 'pending'}><span className="specialist-step-marker" /><div><strong>Lake Agent</strong><p>{finished ? '分析实际结果并回复' : '等待工作流结果'}</p></div></li></ol>
      {finished && <DownloadButton className="specialist-download" filename={`lake-workflow-${call.run_id || call.id}.json`} mimeType="application/json" content={JSON.stringify(call, null, 2)}>下载工作流工具结果与步骤轨迹</DownloadButton>}
    </AgentDisclosure>
  </div>
}
