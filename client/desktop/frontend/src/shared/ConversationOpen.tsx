import { MessageSquare } from 'lucide-react'

export type ConversationSummary = { id: string; lake: string; title: string; project_name?: string; project_path?: string }

export function ConversationOpen({ conversation, onOpen, onDoubleClick }: { conversation: ConversationSummary; onOpen: () => void; onDoubleClick?: () => void }) {
  return <button className="conversation-open" title={conversation.title} onClick={onOpen} onDoubleClick={onDoubleClick}><MessageSquare size={14} /><span>{conversation.title}</span></button>
}
