import { defineCatalog } from '@json-render/core'
import { schema } from '@json-render/react'
import { z } from 'zod'

const empty = z.object({}).strict()
const index = z.object({ index: z.number().int().min(0).max(99) }).strict()
const title = z.object({ title: z.string().min(1).max(80) }).strict()

export const reportCatalog = defineCatalog(schema, {
  components: {
    Stack: { props: empty, slots: ['default'], description: '垂直排列一组结果组件' },
    Grid: { props: z.object({ columns: z.number().int().min(1).max(4) }).strict(), slots: ['default'], description: '一至四列布局，小屏幕自动折行' },
    Card: { props: title, slots: ['default'], description: '带标题的分组卡片' },
    Tabs: { props: z.object({ labels: z.array(z.string().min(1).max(40)).min(2).max(6) }).strict(), slots: ['default'], description: '标签页，每个children对应一个标签，切换保留交互状态' },
    Accordion: { props: title, slots: ['default'], description: '默认收起的详情分组，可展开查看' },
    Metric: { props: index, description: '展示metrics[index]的指标事实' },
    Chart: { props: index, description: '展示charts[index]的状态图或条形图' },
    Finding: { props: index, description: '展示findings[index]的异常及建议' },
    Table: { props: empty, description: '完整清单，内置搜索、筛选和展开' },
    Flow: { props: empty, description: '执行流程，点选节点查看详情' },
  },
  actions: {},
})
