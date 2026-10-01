export type WorkflowPlanning = {
  status: 'adjusted' | 'unchanged' | 'unavailable'
  message: string
  adjustments?: {
    step_id: string
    step_name: string
    timeout_before_seconds: number
    timeout_seconds: number
    wait_for?: string[]
    reason: string
    evidence_run_ids?: string[]
  }[]
}

export function parseWorkflowPlanning(value: unknown): WorkflowPlanning | undefined {
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return undefined } }
  if (!value || typeof value !== 'object') return undefined
  const plan = value as WorkflowPlanning
  if (!['adjusted', 'unchanged', 'unavailable'].includes(plan.status) || typeof plan.message !== 'string') return undefined
  if (plan.adjustments !== undefined && (!Array.isArray(plan.adjustments) || plan.adjustments.length > 32 || plan.adjustments.some(item => !item || typeof item.step_id !== 'string' || typeof item.step_name !== 'string' || typeof item.reason !== 'string' || !Number.isInteger(item.timeout_before_seconds) || !Number.isInteger(item.timeout_seconds) || item.timeout_seconds < item.timeout_before_seconds || item.timeout_seconds > 3600 || item.wait_for !== undefined && (!Array.isArray(item.wait_for) || item.wait_for.some(name => typeof name !== 'string'))))) return undefined
  return plan
}

export function workflowWaitLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
