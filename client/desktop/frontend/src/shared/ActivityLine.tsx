import { Activity, BookOpen, Check, ChevronRight, CircleHelp, FilePenLine, FilePlus2, Files, GitBranch, Globe, History, Layers, LoaderCircle, Save, Search, SquareTerminal, Trash2, X } from 'lucide-react'
import { activityLabel, groupedActivityLabel, groupedActivityStatus, isPresentationFormatRejection, type ToolActivity } from '../activity'
import './ActivityLine.css'

const icons = { read: BookOpen, list: Files, search: Search, command: SquareTerminal, edit: FilePenLine, create: FilePlus2, delete: Trash2, restore: History, checkpoint: Save, browser: Globe, query: Search, task: SquareTerminal, workflow: GitBranch, report: Activity, context: Layers, tool: Activity }
const statusLabel = { running: '处理中', completed: '已完成', failed: '失败', unknown: '结果未知', cancelled: '已取消' }

export function ActivityLine({ activities }: { activities: ToolActivity[] }) {
  const first = activities[0]
  const Icon = icons[first.kind === 'report' ? 'report' : activities.length > 1 ? activities.some(item => ['edit', 'create', 'delete'].includes(item.kind)) ? 'edit' : activities.some(item => item.kind === 'command') ? 'command' : 'search' : first.kind]
  const status = groupedActivityStatus(activities)
  const formatting = status === 'failed' && activities.every(isPresentationFormatRejection)
  const duration = activities.reduce((sum, item) => sum + (item.durationMS ?? 0), 0)
  const label = groupedActivityLabel(activities)
  return <div className={`message-row activity tool-activity ${status}${formatting ? ' format-adjustment' : ''}`}>
    <details className="tool-activity-disclosure">
      <summary aria-label={`${label}，展开或收起详情`}>
        <Icon className="tool-activity-icon" size={15} aria-hidden="true" />
        <span className="tool-activity-label">{label}</span>
        {activities.length === 1 && first.detail && <span className="tool-activity-preview">{first.detail}</span>}
        {status === 'running' ? <LoaderCircle className="spin" size={13} aria-label="处理中" /> : formatting ? <CircleHelp size={13} aria-label="界面格式待调整" /> : status === 'failed' || status === 'cancelled' ? <X size={13} aria-hidden="true" /> : status === 'unknown' ? <CircleHelp size={13} aria-hidden="true" /> : <Check className="tool-activity-check" size={12} aria-hidden="true" />}
        <ChevronRight className="tool-activity-chevron" size={12} aria-hidden="true" />
      </summary>
      <div className="tool-activity-details">
        {activities.map(item => <div className="tool-activity-item" key={item.id}><div><strong>{activityLabel(item)}</strong><span>{isPresentationFormatRejection(item) ? '格式未通过' : statusLabel[item.status]}</span></div>{item.detail && <p>{item.detail}</p>}{item.tool && <small>{item.tool}</small>}</div>)}
        {duration > 0 && <p className="tool-activity-duration">调用耗时 {(duration / 1000).toFixed(1)} 秒</p>}
      </div>
    </details>
  </div>
}
