import { VisualReportCard } from './VisualReportCard'
import { lazy, Suspense, useMemo } from 'react'
const A2UISurfaceCard = lazy(() => import('./A2UISurface').then(module => ({ default: module.A2UISurfaceCard })))
import type { UIAction } from '../a2ui'
import { ExecutionCard } from './ExecutionCard'
import type { ExecutionRecord } from '../taskTerminal'
import { Activity, LoaderCircle, Plug, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MessageBubble, MessageBubbleContent } from '../components/beui/message-bubble'
import { SpecialistCallCard } from '../SpecialistCallCard'
import { reportRecoveryRunIDs, type ChatMessage } from '../timeline'
import { isReportFormattingError } from '../visualReport'
import { QuestionCard } from './QuestionCard'
import { DownloadButton } from './DownloadButton'
import { ActivityLine } from './ActivityLine'
import { canGroupActivities, canGroupPresentationActivities, type ToolActivity } from '../activity'
import { automaticReplySurfaces } from '../automaticReply'

function AssistantReply({ message, uiScope, onCommandFill }: { message: ChatMessage; uiScope: string; onCommandFill?: (command: string) => void }) {
 const surfaces = useMemo(() => automaticReplySurfaces(message.text, `${uiScope}:${message.id}`), [message.text, message.id, uiScope])
 const content = <Suspense fallback={<p>正在整理回复…</p>}>{surfaces.map(snapshot => <A2UISurfaceCard key={snapshot.surfaceId} snapshot={snapshot} reply onCommandFill={onCommandFill} />)}</Suspense>
 return <div className="message-row assistant automatic-reply" data-message-id={message.id}><div className="message-body">{message.detail ? <details className="message-detail"><summary>完整分析说明</summary>{content}</details> : content}{message.stats && <div className="stats"><Activity size={12} />{message.stats}</div>}</div></div>
}

function mcpToolLabel(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function attachmentLabel(name?: string): string {
  if (name?.toLowerCase().includes('.pdf · 第')) return 'PDF 页面预览'
  if (name?.includes(' · ') && name.includes('秒')) return '视频关键帧'
  return '图片'
}

function attachmentFilename(name: string | undefined, mime: string): string {
  const stem = (name || 'lake-attachment').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
  return `${stem}.${mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg'}`
}

function MessageMarkdown({ text, onCommandFill }: { text: string; onCommandFill?: (command: string) => void }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={onCommandFill ? { pre: ({ children }) => { const node = (Array.isArray(children) ? children[0] : children) as { props?: { children?: unknown } }; const command = typeof node?.props?.children === "string" ? node.props.children.trim() : ""; return <div className="message-command-block"><pre>{children}</pre>{command && !command.includes("\n") && command.length <= 4000 && <button type="button" onClick={() => onCommandFill(command)}>填入命令框</button>}</div> } } : undefined}>{text}</ReactMarkdown>
}

function ReportFormattingFailure({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return <div className="report-format-error"><strong>结果展示未完成</strong><p>报告格式有误，已有执行记录和数据仍保留。</p>{onRetry && <button type="button" className="message-visualize" onClick={onRetry}>重新整理结果</button>}<details><summary>查看错误详情</summary><pre>{text}</pre></details></div>
}

export function ConversationMessages({ messages, onQuestionAnswer, onExecutionQuote, onCommandFill, onReportRetry, onUIAction, busy, uiScope = '' }: { messages: ChatMessage[]; uiScope?: string; onUIAction?: (action: UIAction) => Promise<void>; busy?: boolean; onReportRetry?: (runIDs: string[]) => void; onExecutionQuote?: (record: ExecutionRecord) => void; onCommandFill?: (command: string) => void; onQuestionAnswer?: (questionID: string, answers: Record<string, string>) => Promise<void> }) {
  const rows: (ChatMessage | ToolActivity[])[] = []
  for (const message of messages) {
    if (message.activity) {
      const previous = rows.at(-1)
      if (Array.isArray(previous) && (canGroupActivities(previous, message.activity) || canGroupPresentationActivities(previous, message.activity))) previous.push(message.activity)
      else rows.push([message.activity])
    } else rows.push(message)
  }
  return <>{rows.map(row => {
    if (Array.isArray(row)) return <ActivityLine key={row[0].id} activities={row} />
    const message = row
    if (message.role === 'assistant') return <AssistantReply key={`${uiScope}:${message.id}`} message={message} uiScope={uiScope} onCommandFill={onCommandFill} />
    if (message.role === 'ui' && message.ui) return <div className="message-row ui" key={`${uiScope}:${message.id}`}><Suspense fallback={<p>正在准备交互界面…</p>}><A2UISurfaceCard snapshot={message.ui} onAction={onUIAction} busy={busy} onCommandFill={onCommandFill} /></Suspense></div>
    return message.role === 'report' && message.report ? <div className="message-row report" key={message.id}><VisualReportCard report={message.report} /></div> : message.role === 'execution' && message.execution ? <div className="message-row execution" key={message.id}><ExecutionCard record={message.execution} onQuote={onExecutionQuote} onFill={onCommandFill} /></div> : message.role === 'question' && message.question ? <div className="message-row question" key={message.id}><QuestionCard question={message.question} onAnswer={message.question.status === 'pending' && onQuestionAnswer ? answers => onQuestionAnswer(message.question!.id, answers) : undefined} /></div> : message.role === 'specialist' && message.specialist ? <div className="message-row specialist" key={message.id}><SpecialistCallCard call={message.specialist} /></div> : message.role === 'mcp' && message.mcp ? <div className={'message-row mcp ' + message.mcp.status} key={message.id} title={message.mcp.status === 'completed' ? 'MCP 调用已完成' : message.mcp.status === 'failed' ? 'MCP 调用失败或中断' : 'MCP 调用中'}><Plug size={15} /><span>MCP</span><strong>{message.mcp.server}</strong><span className="mcp-separator">·</span><span className="mcp-tool-name">{mcpToolLabel(message.mcp.tool)}</span>{message.mcp.status === 'running' && <LoaderCircle className="spin mcp-call-spinner" size={12} />}{message.mcp.status === 'failed' && <X className="mcp-call-failed" size={12} />}</div> : message.role === 'activity' ? <div className="message-row activity" key={message.id}><Activity size={12} />{message.text}</div> : <div className={'message-row ' + message.role} key={message.id}>
    <div className="message-body">{message.role === 'error' && isReportFormattingError(message.text) ? <ReportFormattingFailure text={message.text} onRetry={onReportRetry ? () => onReportRetry(reportRecoveryRunIDs(messages, message.id)) : undefined} /> : <>{message.role === 'error' && <span className="message-author">错误</span>}
      {message.detail && <details className="message-detail"><summary>完整分析说明</summary><MessageBubble align="start" variant="ghost"><MessageBubbleContent className="lake-bubble"><MessageMarkdown text={message.text} onCommandFill={onCommandFill} /></MessageBubbleContent></MessageBubble></details>}
      {!message.detail && <MessageBubble align={message.role === 'user' ? 'end' : 'start'} variant={message.role === 'error' ? 'danger' : message.role === 'user' ? 'soft' : 'ghost'} animateIn>
        <MessageBubbleContent className="lake-bubble">{message.images?.length ? <div className="message-images">{message.images.map((image, index) => <figure key={index}><img src={`data:${image.mime_type};base64,${image.data}`} alt={image.name || `图片 ${index + 1}`} /><figcaption><span>{attachmentLabel(image.name)} · {image.name || `图片 ${index + 1}`}</span><DownloadButton filename={attachmentFilename(image.name, image.mime_type)} mimeType={image.mime_type} content={image.data} encoding="base64">下载预览</DownloadButton></figcaption></figure>)}</div> : null}<MessageMarkdown text={message.text} onCommandFill={onCommandFill} /></MessageBubbleContent>
      </MessageBubble>}
      {message.stats && <div className="stats"><Activity size={12} />{message.stats}</div>}
    </>}
    </div>
  </div>})}</>
}
