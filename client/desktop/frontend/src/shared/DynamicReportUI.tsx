import { Children, createContext, useContext, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { defineRegistry, JSONUIProvider, Renderer, type Spec } from '@json-render/react'
import { reportCatalog } from '../reportCatalog'
import { defaultReportUI } from '../reportUI'
import type { VisualReport } from '../visualReport'
import { ReportChart, ReportFinding, ReportFlowView, ReportMetric, ReportTableView } from './ReportWidgets'

const ReportContext = createContext<VisualReport | null>(null)
function useReport() {
  const report = useContext(ReportContext)
  if (!report) throw new Error('结果组件缺少报告数据')
  return report
}

function Tabs({ labels, children }: { labels: string[]; children?: ReactNode }) {
  const [active, setActive] = useState(0)
  const prefix = useId(), panels = Children.toArray(children), selected = Math.min(active, labels.length - 1)
  return <div className="report-ui-tabs">
    <div className="report-ui-tablist" role="tablist" aria-label="结果视图">
      {labels.map((label, index) => <button type="button" key={index} id={`${prefix}-tab-${index}`} role="tab" aria-selected={selected === index} aria-controls={`${prefix}-panel-${index}`} tabIndex={selected === index ? 0 : -1} onClick={() => setActive(index)} onKeyDown={event => {
        let next = index
        if (event.key === 'ArrowRight') next = (index + 1) % labels.length
        else if (event.key === 'ArrowLeft') next = (index + labels.length - 1) % labels.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = labels.length - 1
        else return
        event.preventDefault(); setActive(next)
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
      }}>{label}</button>)}
    </div>
    {panels.map((panel, index) => <section key={index} id={`${prefix}-panel-${index}`} role="tabpanel" aria-labelledby={`${prefix}-tab-${index}`} hidden={selected !== index} tabIndex={0}>{panel}</section>)}
  </div>
}

const { registry } = defineRegistry(reportCatalog, {
  components: {
    Stack: ({ children }) => <div className="report-ui-stack">{children}</div>,
    Grid: ({ props, children }) => <div className="report-ui-grid" style={{ '--ui-columns': props.columns } as CSSProperties}>{children}</div>,
    Card: ({ props, children }) => <section className="report-ui-card"><h4>{props.title}</h4><div className="report-ui-stack">{children}</div></section>,
    Tabs: ({ props, children }) => <Tabs labels={props.labels} children={children} />,
    Accordion: ({ props, children }) => <details className="report-ui-accordion"><summary>{props.title}</summary><div className="report-ui-stack">{children}</div></details>,
    Metric: ({ props }) => { const report = useReport(); return <ReportMetric metric={report.metrics![props.index]} /> },
    Chart: ({ props }) => { const report = useReport(); return <ReportChart chart={report.charts![props.index]} /> },
    Finding: ({ props }) => { const report = useReport(); return <ReportFinding finding={report.findings![props.index]} /> },
    Table: () => <ReportTableView table={useReport().table!} />,
    Flow: () => <ReportFlowView flow={useReport().flow!} />,
  },
})

export function DynamicReportUI({ report }: { report: VisualReport }) {
  const spec = useMemo(() => {
    const ui = report.ui ?? defaultReportUI(report)
    const normalized: Spec = { root: ui.root, elements: Object.fromEntries(Object.entries(ui.elements).map(([id, element]) => [id, { ...element, props: { ...element.props }, children: element.children ?? [] }])) }
    if (reportCatalog.validate(normalized).success) return normalized
    // An old report remains readable even if a future catalog changes a prop.
    const fallback = defaultReportUI(report)
    return { root: fallback.root, elements: Object.fromEntries(Object.entries(fallback.elements).map(([id, element]) => [id, { ...element, props: { ...element.props }, children: element.children ?? [] }])) } satisfies Spec
  }, [report])
  return <ReportContext.Provider value={report}><div className="report-ui" data-ui-engine="json-render"><JSONUIProvider registry={registry}><Renderer spec={spec} registry={registry} /></JSONUIProvider></div></ReportContext.Provider>
}
