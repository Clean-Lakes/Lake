import { AlertTriangle, ChartNoAxesCombined, CheckCircle2, Info } from 'lucide-react'
import { isWorkflowExecutionReport, nodeStatusLabel, reportToneLabel, type VisualReport } from '../visualReport'
import { DynamicReportUI } from './DynamicReportUI'
import './VisualReportCard.css'

export function VisualReportCard({ report }: { report: VisualReport }) {
  if (isWorkflowExecutionReport(report)) {
    const nodes = report.flow!.nodes, completed = nodes.filter(node => node.status === 'completed').length
    const attention = nodes.some(node => node.status === 'failed' || node.status === 'unknown')
    return <details className="workflow-execution-report"><summary>{attention ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}<strong>{report.title.replace(/ · 执行结果$/, '')}</strong><span>执行记录 · {completed}/{nodes.length} 步</span></summary><div className="workflow-execution-details"><p>{report.summary}</p><ul>{nodes.map(node => <li key={node.id}><strong>{node.label}</strong><span>{nodeStatusLabel[node.status]}</span>{node.detail && <small>{node.detail}</small>}</li>)}</ul>{report.sources?.map((source, index) => <p className="report-scope" key={index}>{source}</p>)}</div></details>
  }
  const Icon = report.tone === 'good' ? CheckCircle2 : report.tone === 'critical' || report.tone === 'warning' ? AlertTriangle : Info
  return <article className={`visual-report ${report.tone}`} aria-label={report.title}>
    <header className="report-header"><div className="report-eyebrow"><ChartNoAxesCombined size={14} />结果概览 <span className={`report-status ${report.tone}`}><Icon size={12} />{reportToneLabel[report.tone]}</span></div><h3>{report.title}</h3><p>{report.summary}</p>{report.scope && <div className="report-scope">检查范围 · {report.scope}</div>}</header>
    <DynamicReportUI report={report} />
    {!!report.sources?.length && <details className="report-sources"><summary>查看依据与运行信息</summary><ul>{report.sources.map((source, i) => <li key={i}>{source}</li>)}</ul></details>}
  </article>
}
