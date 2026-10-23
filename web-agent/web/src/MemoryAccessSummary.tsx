import type {MemoryAccess} from '../../shared/contracts';
import {DisclosureSummary} from './DisclosureSummary';
import {memoryTime} from './projectMemoryState';
export function MemoryAccessSummary({entries,onOpen}:{entries:MemoryAccess[];onOpen?:()=>void}){
 if(!entries.length)return null;
 const visible=[...new Map(entries.map(entry=>[`${entry.key}:${entry.revision}:${entry.kind}`,entry])).values()];
 const indexed=visible.filter(entry=>entry.kind==='index').length,read=visible.filter(entry=>entry.kind==='read').length;
 return <details className="memory-access-summary"><DisclosureSummary>项目记忆 · 索引 {indexed} 条 / 已读取 {read} 条</DisclosureSummary>{visible.map(entry=><p key={`${entry.key}:${entry.revision}:${entry.kind}`}><button type="button" disabled={!onOpen} onClick={onOpen}>{entry.key} · 版本 {entry.revision}</button><span>{entry.kind==='index'?'仅索引':'已读取'}{entry.historical?' · 历史资料':''} · {entry.observedAt?memoryTime(entry.observedAt):'无现场观测'}</span></p>)}</details>;
}
