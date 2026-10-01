type WorkflowTrace = {
  stage: string
  completed?: number
  total?: number
  steps?: { status: string }[]
}

export function workflowTraceSummary(call: WorkflowTrace): string {
  const steps = call.steps ?? []
  const total = Math.max(call.total ?? 0, steps.length)
  if (!steps.length) {
    const label = call.stage === 'completed' ? '已执行' : call.stage === 'failed' ? '已中断 · 已结束' : '已结束'
    return `${label} ${call.completed ?? 0}/${total}`
  }
  const success = steps.filter(step => step.status === 'completed').length
  const unknown = steps.filter(step => step.status === 'unknown').length
  const failed = steps.filter(step => step.status === 'failed').length
  const skipped = steps.filter(step => step.status === 'skipped').length
  const cancelled = steps.filter(step => step.status === 'cancelled').length
  const label = call.stage === 'failed' ? success > 0 ? '部分完成' : '已中断' : call.stage === 'completed' ? '已完成' : '执行中 · 完成'
  const details = [unknown ? `${unknown} 项结果未知` : '', failed ? `${failed} 项失败` : '', cancelled ? `${cancelled} 项取消` : '', skipped ? `${skipped} 项跳过` : ''].filter(Boolean)
  return `${label} ${success}/${total}${details.length ? ` · ${details.join('，')}` : ''}`
}

export function workflowStepMessage(step: { status: string; message?: string }): string {
  if (step.status === 'unknown' && /deadline exceeded/.test(step.message ?? '')) return '等待执行结果超时，尚未确认远端命令是否结束'
  return step.message ?? ''
}
