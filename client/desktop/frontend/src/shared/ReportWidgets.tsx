import { useId, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, GitBranch, Info, Search } from 'lucide-react'
import { flowLayout, nodeStatusLabel, nodeTone, reportToneLabel, type ReportFlow, type VisualReport } from '../visualReport'

const colors = { good: '#65c49a', warning: '#e1b568', critical: '#ed8b92', info: '#87acf0', unknown: '#858997' }
const number = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })

export function ReportChart({ chart }: { chart: NonNullable<VisualReport['charts']>[number] }) {
  const total = chart.segments.reduce((sum, s) => sum + s.value, 0)
  const max = Math.max(1, ...chart.segments.map(s => s.value))
  let offset = 0
  return <section className="report-chart" aria-label={chart.title}>
    <h4>{chart.title}</h4>
    {chart.kind === 'distribution' ? <div className="report-distribution">
      <svg className="report-donut" viewBox="0 0 120 120" role="img" aria-label={chart.segments.map(s => `${s.label} ${number(s.value)}${chart.unit || ''}`).join('，')}>
        <circle cx="60" cy="60" r="45" fill="none" stroke="#34373f" strokeWidth="11" />
        {chart.segments.map((s, index) => { const percent = total ? s.value / total * 100 : 0; const start = offset; offset += percent; return <circle key={index} cx="60" cy="60" r="45" fill="none" stroke={colors[s.tone]} strokeWidth="11" pathLength="100" strokeDasharray={`${percent} ${100 - percent}`} strokeDashoffset={-start} transform="rotate(-90 60 60)"><title>{s.label}：{number(s.value)}{chart.unit}</title></circle> })}
        <text x="60" y="57" textAnchor="middle" className="report-donut-value">{number(total)}</text><text x="60" y="76" textAnchor="middle" className="report-donut-unit">{chart.unit || '合计'}</text>
      </svg>
      <ul className="report-legend">{chart.segments.map((s, index) => <li key={index}><i style={{ background: colors[s.tone] }} /><span>{s.label}</span><strong>{number(s.value)}<small>{chart.unit}</small></strong></li>)}</ul>
    </div> : <div className="report-bars">{chart.segments.map((s, index) => <div className="report-bar-row" key={index}><div><span>{s.label}</span><strong>{number(s.value)}{chart.unit}</strong></div><div className="report-bar-track"><span style={{ width: `${s.value / max * 100}%`, background: colors[s.tone] }} /></div></div>)}</div>}
  </section>
}

export function ReportFlowView({ flow }: { flow: ReportFlow }) {
  const [selected, setSelected] = useState<string | null>(null)
  const marker = useId().replace(/:/g, '')
  const layout = flowLayout(flow)
  if (!layout) return null
  const node = flow.nodes.find(n => n.id === selected)
  if (flow.nodes.length === 1) {
    const step = flow.nodes[0]
    return <section className="report-flow report-flow-single"><h4><GitBranch size={14} />执行步骤</h4><button type="button" className={`report-single-step ${nodeTone(step.status)}`} onClick={() => setSelected(selected === step.id ? null : step.id)} aria-expanded={selected === step.id}><strong>{step.label}</strong><span>{nodeStatusLabel[step.status]}<ChevronDown size={13} /></span></button>{node && <div className="report-node-detail"><p>{node.detail || '没有额外说明'}</p></div>}</section>
  }
  return <section className="report-flow"><h4><GitBranch size={14} />执行流程 <small>点选节点查看详情</small></h4>
    <div className="report-flow-scroll"><div className="report-flow-canvas" style={{ width: layout.width, height: layout.height }}>
      <svg width={layout.width} height={layout.height} aria-hidden="true"><defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#717b8f" /></marker></defs>
        {flow.edges?.map((e, index) => {const from = layout.positions.get(e.from)!, to = layout.positions.get(e.to)!; const x1 = from.x + 90, y1 = from.y + 72, x2 = to.x + 90, y2 = to.y; return <path key={index} d={`M${x1},${y1} C${x1},${(y1 + y2)/2} ${x2},${(y1 + y2)/2} ${x2},${y2 - 3}`} fill="none" stroke="#586479" strokeWidth="1.5" markerEnd={`url(#${marker})`} />})}
      </svg>
      {flow.nodes.map(n => <button key={n.id} className={`report-flow-node ${nodeTone(n.status)} ${selected === n.id ? 'selected' : ''}`} style={{ left: layout.positions.get(n.id)!.x, top: layout.positions.get(n.id)!.y }} onClick={() => setSelected(selected === n.id ? null : n.id)} aria-pressed={selected === n.id} title={n.label}><strong>{n.label}</strong><span><i />{nodeStatusLabel[n.status]}</span></button>)}
    </div></div>
    {node && <div className="report-node-detail"><strong>{node.label} · {nodeStatusLabel[node.status]}</strong><p>{node.detail || '没有额外说明'}</p></div>}
  </section>
}

export function ReportTableView({ table }: { table: NonNullable<VisualReport['table']> }) {
  const [query, setQuery] = useState(''), [attention, setAttention] = useState(false), [expanded, setExpanded] = useState(false)
  const rows = table.rows.filter(row => (!attention || ['warning', 'critical', 'unknown'].includes(row.tone)) && row.cells.join(' ').toLowerCase().includes(query.toLowerCase()))
  return <section className="report-table-section"><div className="report-table-heading"><h4>{table.title}<small>{rows.length} 项</small></h4><button type="button" className={attention ? 'active' : ''} aria-pressed={attention} onClick={() => {setAttention(!attention);setExpanded(false)}}>只看需关注</button></div>
    <label className="report-search"><Search size={13} /><input aria-label={`搜索${table.title}`} placeholder="搜索名称或状态" value={query} onChange={e => {setQuery(e.target.value);setExpanded(false)}} /></label>
    <div className="report-table-scroll"><table><thead><tr>{table.columns.map((col, i) => <th key={i}>{col}</th>)}</tr></thead><tbody>{rows.slice(0, expanded ? rows.length : 8).map((row, i) => <tr key={i} className={row.tone}>{row.cells.map((cell, j) => <td key={j}>{j === 0 && <i className="report-row-dot" aria-label={reportToneLabel[row.tone]} />}{cell}</td>)}</tr>)}</tbody></table></div>
    {!rows.length && <p className="report-empty">没有符合条件的项目</p>}
    {rows.length > 8 && <button className="report-show-more" onClick={() => setExpanded(!expanded)}><ChevronDown size={13} />{expanded ? '收起清单' : `展开全部 ${rows.length} 项`}</button>}
  </section>
}

export function ReportMetric({ metric: m }: { metric: NonNullable<VisualReport['metrics']>[number] }) {
  return <div className={`report-metric ${m.tone}`}><span>{m.label}</span><strong>{m.value}</strong>{m.hint && <small>{m.hint}</small>}</div>
}

export function ReportFinding({ finding: f }: { finding: NonNullable<VisualReport['findings']>[number] }) {
  return <div className={`report-finding ${f.tone}`}><span className="report-finding-icon">{f.tone === 'good' ? <CheckCircle2 size={15} /> : f.tone === 'info' || f.tone === 'unknown' ? <Info size={15} /> : <AlertTriangle size={15} />}</span><div><strong>{f.title}</strong><p>{f.detail}</p>{f.next_step && <div className="report-next-step">建议 · {f.next_step}</div>}</div></div>
}
