import {useState} from 'react';
import type {ProjectMemoryEntry,Resource} from '../../shared/contracts';
import {MemoryScopeFields} from './ProjectMemoryDetail';
import {memoryDraft,type MemoryDraft} from './projectMemoryState';

export function ProjectMemoryClassification({items,resources,busy,onApply}:{items:ProjectMemoryEntry[];resources:Resource[];busy:boolean;onApply:(items:{key:string;expectedRevision:number}[],draft:MemoryDraft)=>Promise<void>}){
 const [expanded,setExpanded]=useState(false);
 const [selected,setSelected]=useState<string[]>([]);
 const [reviewed,setReviewed]=useState(false);
 const [draft,setDraft]=useState<MemoryDraft>(()=>({...memoryDraft(),scopeKind:'resources'}));
 const rows=items.filter(item=>item.reviewState==='needs_review'&&!item.deletedAt);
 if(!rows.length)return null;
 return <section className="memory-candidates" aria-label="旧记忆批量分类">
  <button className="button secondary" disabled={busy} onClick={()=>setExpanded(!expanded)}>批量分类本页旧记忆</button>
  {expanded&&<fieldset className="memory-editor-fields" disabled={busy}>
   <p className="modal-description">先逐条检查内容，再为所选记录设置共同种类与范围。正文和对象条件保持原样；分类不会刷新历史观测。</p>
   {rows.map(item=><label className="memory-check" key={item.key}><input type="checkbox" checked={selected.includes(item.key)} onChange={event=>{setReviewed(false);setSelected(event.target.checked?[...selected,item.key]:selected.filter(key=>key!==item.key))}}/><span>{item.description||item.key}</span></label>)}
   <MemoryScopeFields draft={draft} resources={resources} onChange={next=>{setDraft(next);setReviewed(false)}}/>
   <label className="memory-check"><input type="checkbox" checked={reviewed} onChange={event=>setReviewed(event.target.checked)}/>我已逐条查看所选记录，确认共同分类与范围适用</label>
   <button className="button primary" disabled={!reviewed||!selected.length||draft.scopeKind==='resources'&&!draft.resourceIds.length} onClick={()=>void onApply(rows.filter(item=>selected.includes(item.key)).map(item=>({key:item.key,expectedRevision:item.revision})),draft).then(()=>{setSelected([]);setReviewed(false)})}>确认分类 {selected.length} 条</button>
  </fieldset>}
 </section>;
}
