import {AppSelect} from './AppSelect';
import type {ProjectMemoryEntry,Resource,MemoryKnowledgeKind} from '../../shared/contracts';
import {eligibilityLabels,knowledgeLabels,memoryTime,type MemoryDraft} from './projectMemoryState';

export function MemoryScopeFields({draft,resources,onChange}:{draft:MemoryDraft;resources:Resource[];onChange:(draft:MemoryDraft)=>void}){
 return <>
  <label className="field-label">知识种类<AppSelect value={draft.knowledgeKind} onChange={event=>{const kind=event.target.value as MemoryKnowledgeKind;const scoped=!['preference','procedure'].includes(kind);onChange({...draft,knowledgeKind:kind,scopeKind:scoped?'resources':draft.scopeKind,alwaysReference:scoped?false:draft.alwaysReference})}}>{Object.entries(knowledgeLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</AppSelect></label>
  <label className="field-label">适用范围<AppSelect value={draft.scopeKind} onChange={event=>onChange({...draft,scopeKind:event.target.value as MemoryDraft['scopeKind'],resourceIds:event.target.value==='project'?[]:draft.resourceIds,alwaysReference:false})}><option value="project" disabled={!['preference','procedure'].includes(draft.knowledgeKind)}>整个项目</option><option value="resources">指定资源</option></AppSelect></label>
  {draft.scopeKind==='resources'&&<fieldset className="memory-resource-picker"><legend>选择全部关联资源</legend>{resources.map(resource=><label key={resource.id}><input type="checkbox" checked={draft.resourceIds.includes(resource.id)} onChange={event=>onChange({...draft,resourceIds:event.target.checked?[...draft.resourceIds,resource.id]:draft.resourceIds.filter(id=>id!==resource.id)})}/><span>{resource.name}</span></label>)}{!resources.length&&<p>当前项目没有可选资源。</p>}</fieldset>}
 </>;
}

export function ProjectMemoryDetail({draft,entry,resources,busy,onChange,onSave,onForget,onBack,onSource}:{draft:MemoryDraft;entry:ProjectMemoryEntry|null;resources:Resource[];busy:boolean;onChange:(draft:MemoryDraft)=>void;onSave:()=>void;onForget:()=>void;onBack:()=>void;onSource:(sourceId:string)=>void}){
 return <section className="memory-detail" aria-label="记忆详情">
  <button className="button secondary memory-detail-back" disabled={busy} onClick={onBack}>返回列表</button>
  <header><h3>{draft.restoreDeleted?'重新建立已遗忘的记忆':draft.revision?'记忆详情':'新增记忆'}</h3><span className="memory-state">{entry?eligibilityLabels[entry.eligibility||'']||'待检查':'新条目'}</span></header>
  {draft.restoreDeleted&&<p className="modal-description">原内容已清除。恢复需要重新填写事实、范围和来源，不会找回已遗忘的正文。</p>}
  {entry&&<div className="memory-facts"><span>{entry.verification==='observed'?'已有观测':entry.verification==='reference'?'参考资料':'用户陈述'}</span><span>版本 {entry.revision}</span>{entry.historical&&<span>历史案例</span>}</div>}
  <form onSubmit={event=>{event.preventDefault();onSave()}}><fieldset className="memory-editor-fields" disabled={busy}>
   <label className="field-label">标题<input required maxLength={160} value={draft.description} onChange={event=>onChange({...draft,description:event.target.value})}/></label>
   <MemoryScopeFields draft={draft} resources={resources} onChange={onChange}/>
   <label className="field-label">事实或方法<textarea required rows={7} value={draft.body} placeholder="说明适用条件、事实或方法、再次使用前的检查点与限制。" onChange={event=>onChange({...draft,body:event.target.value})}/></label>
   <label className="field-label">适用对象或条件<input value={typeof draft.subject.conditions==='string'?draft.subject.conditions:''} onChange={event=>onChange({...draft,subject:{...draft.subject,kind:typeof draft.subject.kind==='string'?draft.subject.kind:'none',conditions:event.target.value}})}/></label>
   <div className="memory-technical-fields"><label className="field-label">条目键<input required pattern="[a-z][a-z0-9-]{0,63}" disabled={draft.revision>0} value={draft.key} onChange={event=>onChange({...draft,key:event.target.value,factKey:draft.factKey===draft.key?event.target.value:draft.factKey})}/></label><label className="field-label">事实标识<input required value={draft.factKey} onChange={event=>onChange({...draft,factKey:event.target.value})}/></label></div>
   <label className="field-label">有效期上界（可选）<input value={draft.validUntil} placeholder="2026-10-24T08:00:00+08:00" onChange={event=>onChange({...draft,validUntil:event.target.value})}/></label>
   {draft.scopeKind==='project'&&<label className="memory-check"><input type="checkbox" checked={draft.alwaysReference} onChange={event=>onChange({...draft,alwaysReference:event.target.checked})}/>始终参考（项目内最多 2 条）</label>}
   <label className="memory-check"><input type="checkbox" checked={draft.reviewState==='disabled'} onChange={event=>onChange({...draft,reviewState:event.target.checked?'disabled':'active'})}/>暂停此条记忆</label>
   {entry&&<dl className="memory-times"><dt>观测时间</dt><dd>{memoryTime(entry.observedAt)}</dd><dt>陈述时间</dt><dd>{memoryTime(entry.assertedAt)}</dd><dt>内容更新</dt><dd>{memoryTime(entry.updatedAt)}</dd><dt>有效至</dt><dd>{entry.validUntil?memoryTime(entry.validUntil):'无自动到期'}</dd></dl>}
   {(draft.knowledgeKind==='configuration'||draft.knowledgeKind==='topology')&&<p className="modal-description">编辑不会刷新现场观测或延长原有效期。再次使用前仍需核对当前资源与版本。</p>}
   {!!entry?.sources?.length&&<section className="memory-sources"><h4>来源</h4>{entry.sources.map((source,index)=><div key={source.sourceId||index}><span>{source.kind==='evidence'?'执行证据':source.kind==='review'?'用户复核':'用户陈述'} · {memoryTime(source.observedAt||source.assertedAt||source.at)}</span>{source.excerpt&&<p>{source.excerpt}</p>}{source.sourceId&&<button type="button" className="button secondary" onClick={()=>onSource(source.sourceId!)}>查看来源</button>}</div>)}</section>}
   <div className="modal-actions">{draft.revision>0&&!draft.restoreDeleted&&<button type="button" className="button danger" disabled={busy} onClick={onForget}>遗忘</button>}<button type="button" className="button secondary" onClick={onBack}>取消</button><button type="submit" className="button primary" disabled={busy||draft.scopeKind==='resources'&&!draft.resourceIds.length}>{busy?'正在保存…':draft.restoreDeleted?'明确重新建立':'保存'}</button></div>
  </fieldset></form>
 </section>;
}
