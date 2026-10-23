import {useEffect,useReducer,useRef,useState} from 'react';
import type {MemoryCandidate,Project,ProjectMemoryEntry,ProjectMemoryJob,Resource} from '../../shared/contracts';
import {Glyph} from './Icons';
import {AppSelect} from './AppSelect';
import {DisclosureSummary} from './DisclosureSummary';
import {api,readableError} from './api';
import {ProjectMemoryDetail} from './ProjectMemoryDetail';
import {ProjectMemoryCandidates} from './ProjectMemoryCandidates';
import {ProjectMemoryClassification} from './ProjectMemoryClassification';
import {eligibilityLabels,knowledgeLabels,memoryDraft,memoryTime,memoryJobUsage,memoryJobReason,reduceMemoryView,type MemoryDraft} from './projectMemoryState';
import './projectMemory.css';

export function ProjectMemoryV2({project,resources,onClose,onOpenSource}:{project:Project;resources:Resource[];onClose:()=>void;onOpenSource?:(sessionId:string,turnId?:string)=>void}){
 const [view,dispatch]=useReducer(reduceMemoryView,{projectId:project.id,sequence:0,list:null,error:''});
 const [query,setQuery]=useState('');const [tab,setTab]=useState('active');const [kind,setKind]=useState('');const [offset,setOffset]=useState(0);const [reload,setReload]=useState(0);
 const [draft,setDraft]=useState<MemoryDraft|null>(null);const [entry,setEntry]=useState<ProjectMemoryEntry|null>(null);
 const [candidates,setCandidates]=useState<MemoryCandidate[]>([]);const [jobs,setJobs]=useState<ProjectMemoryJob[]>([]);
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const sequence=useRef(0);const detailSequence=useRef(0);const panel=useRef<HTMLElement>(null);const active=useRef(true);const initialDraft=useRef('');
 useEffect(()=>{active.current=true;const previous=document.activeElement as HTMLElement|null;panel.current?.querySelector<HTMLElement>('button')?.focus();return()=>{active.current=false;detailSequence.current++;if(previous?.isConnected)previous.focus()}},[]);
 useEffect(()=>{
  const controller=new AbortController();const request=++sequence.current;
  dispatch({type:'request',projectId:project.id,sequence:request});
  const filters:Record<string,string>={query,offset:String(offset),limit:'50',includeExpired:tab==='history'||tab==='review'?'true':'false',includeDeleted:tab==='deleted'?'true':'false'};
  if(tab==='active')filters.reviewState='eligible';if(tab==='deleted')filters.reviewState='deleted';if(tab==='review')filters.reviewState='needs_review';if(tab==='history')filters.history='true';if(kind)filters.knowledgeKind=kind;
  api.projectMemoriesV2(project.id,filters,controller.signal).then(list=>{if(!controller.signal.aborted)dispatch({type:'loaded',projectId:project.id,sequence:request,list})}).catch(err=>{if(!controller.signal.aborted)dispatch({type:'failed',projectId:project.id,sequence:request,error:readableError(err)})});
  api.projectMemoryCandidates(project.id,controller.signal).then(result=>{if(!controller.signal.aborted)setCandidates(result.items)}).catch(err=>{if(!controller.signal.aborted)setError(readableError(err))});
  api.projectMemoryJobs(project.id).then(result=>{if(!controller.signal.aborted)setJobs(result.items)}).catch(err=>{if(!controller.signal.aborted)setError(readableError(err))});
  return()=>controller.abort();
 },[project.id,query,tab,kind,offset,reload]);
 useEffect(()=>{const timer=setInterval(()=>{if(document.visibilityState==='visible'&&!busy)setReload(value=>value+1)},5000);return()=>clearInterval(timer)},[busy]);
 function refresh(){setReload(value=>value+1)}
 function canDiscard(){return !draft||JSON.stringify(draft)===initialDraft.current||window.confirm('放弃当前未保存的编辑？')}
 function close(){if(!busy&&canDiscard())onClose()}
 function back(force=false){if(!force&&!canDiscard())return;detailSequence.current++;setDraft(null);setEntry(null);initialDraft.current=''}
 async function open(item:ProjectMemoryEntry){
  if(!canDiscard())return;
  const request=++detailSequence.current;setError('');
  try{const full=await api.projectMemory(project.id,item.key,!!item.deletedAt);if(active.current&&request===detailSequence.current){setEntry(full);initialDraft.current=JSON.stringify(memoryDraft(full));setDraft(memoryDraft(full))}}catch(err){if(active.current&&request===detailSequence.current)setError(readableError(err))}
 }
 async function mutate(action:()=>Promise<unknown>,close=false){
  setBusy(true);setError('');try{const result=await action();if(active.current){if(close)back(true);if(result&&typeof result==='object'&&'publicationError' in result)setError(String(result.publicationError));refresh()}}catch(err){if(active.current)setError(readableError(err))}finally{if(active.current)setBusy(false)}
 }
 function save(){if(!draft)return;const {key,revision,...fields}=draft;void mutate(()=>api.saveProjectMemory(project.id,key,{...fields,expectedRevision:revision}),true)}
 function forget(){if(draft&&window.confirm('遗忘会清除正文、来源摘录、历史版本与关联候选。原会话、执行证据和已有备份保留。继续？'))void mutate(()=>api.forgetProjectMemory(project.id,draft.key,draft.revision),true)}
 async function source(sourceId:string){if(!draft)return;try{const result=await api.projectMemorySource(project.id,draft.key,sourceId);if(!active.current)return;if(result.available&&result.sessionId&&onOpenSource){if(canDiscard())onOpenSource(result.sessionId,result.messageId)}else{setError('原会话或证据暂不可用；保留的来源信息可在此查看。')}}catch(err){if(active.current)setError(readableError(err))}}
 const list=view.list;
 return <div className="modal-scrim project-memory-scrim" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)close()}}><section ref={panel} className="modal memory-v2-modal" role="dialog" aria-modal="true" aria-labelledby="memory-v2-heading" onKeyDown={event=>{
  if(event.key==='Escape'&&!busy){event.preventDefault();event.stopPropagation();if(draft)back();else close()}
  if(event.key==='Tab'){const fields=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(node=>node.getClientRects().length);const first=fields[0],last=fields.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}
 }}>
  <div className="modal-header"><div><h2 id="memory-v2-heading">{project.name} · 项目记忆</h2><p className="modal-description">保留经验与来源，使用前核对当前现场。</p></div><button className="icon-button" aria-label="关闭项目记忆" disabled={busy} onClick={close}><Glyph name="close" size={16}/></button></div>
  {list&&<div className="project-memory-settings"><label><input type="checkbox" disabled={busy} checked={list.settings.useEnabled} onChange={event=>void mutate(()=>api.setProjectMemorySettings(project.id,event.target.checked,list.settings.extractionEnabled,list.settings.settingsRevision))}/>使用记忆</label><label><input type="checkbox" disabled={busy} checked={list.settings.extractionEnabled} onChange={event=>void mutate(()=>api.setProjectMemorySettings(project.id,list.settings.useEnabled,event.target.checked,list.settings.settingsRevision))}/>后台提炼</label></div>}
  {list&&!list.settings.useEnabled&&<p className="modal-description">记忆使用已关闭，后台提炼同时暂停。</p>}
  <div className="memory-v2-toolbar"><input aria-label="搜索项目记忆" placeholder="搜索名称、描述" value={query} onChange={event=>{setQuery(event.target.value);setOffset(0)}}/><AppSelect aria-label="知识种类筛选" value={kind} onChange={event=>{setKind(event.target.value);setOffset(0)}}><option value="">全部种类</option>{Object.entries(knowledgeLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</AppSelect><button className="button secondary" onClick={()=>{if(!canDiscard())return;back(true);const next=memoryDraft();initialDraft.current=JSON.stringify(next);setDraft(next)}}>新增</button></div>
  <nav className="memory-tabs" aria-label="记忆状态">{[['active','可参考'],['review',`待复核${candidates.length?` · ${candidates.length}`:''}`],['history','历史'],['deleted','已遗忘']].map(([value,label])=><button key={value} className={tab===value?'is-active':''} aria-current={tab===value?'page':undefined} onClick={()=>{setTab(value);setOffset(0)}}>{label}</button>)}</nav>
  {(error||view.error)&&<p className="form-error" role="alert">{error||view.error} <button type="button" onClick={refresh}>重新加载</button></p>}
  <div className={`memory-v2-layout${draft?' has-detail':''}`}><section className="memory-v2-list" aria-label="项目记忆列表">
   {!list?<p className="memory-empty">正在加载…</p>:list.items.length?list.items.filter(item=>tab!=='deleted'||!!item.deletedAt).map(item=><button type="button" className={`memory-list-row${draft?.key===item.key?' is-selected':''}`} key={item.key} onClick={()=>void open(item)}><strong>{item.description||item.key}</strong><small>{item.deletedAt?'已遗忘':knowledgeLabels[item.knowledgeKind||'procedure']} · {item.scopeKind==='resources'?(item.resourceNames?.join('、')||'范围待确认'):'项目'} · {eligibilityLabels[item.eligibility||'']||'待检查'}</small><small>{memoryTime(item.observedAt||item.assertedAt||item.updatedAt)}</small></button>):<p className="memory-empty">此分类暂无记忆</p>}
   {list&&list.total>50&&<div className="project-memory-pages"><button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-50))}>上一页</button><span>{offset+1}–{Math.min(offset+50,list.total)} / {list.total}</span><button disabled={offset+50>=list.total} onClick={()=>setOffset(offset+50)}>下一页</button></div>}
   {tab==='review'&&list&&<><ProjectMemoryClassification items={list.items} resources={resources} busy={busy} onApply={(items,draft)=>mutate(()=>api.classifyProjectMemories(project.id,{items,expectedProjectRevision:list.projectRevision,knowledgeKind:draft.knowledgeKind,scopeKind:draft.scopeKind,resourceIds:draft.resourceIds}))}/><ProjectMemoryCandidates projectId={project.id} candidates={candidates} resources={resources} projectRevision={list.projectRevision} onChanged={refresh}/></>}
  </section>{draft&&<ProjectMemoryDetail draft={draft} entry={entry} resources={resources} busy={busy} onChange={setDraft} onSave={save} onForget={forget} onBack={()=>back()} onSource={id=>void source(id)}/>}</div>
  <details className="project-memory-jobs"><DisclosureSummary>后台任务 · {jobs.length}</DisclosureSummary>{jobs.map(job=><div key={job.jobId}><span>{memoryTime(job.createdAt)} · {({queued:'待处理',running:'提炼中',succeeded:'已处理',no_op:'无新记忆',failed:'失败',blocked:'需处理',skipped:'已跳过',budget_wait:'等待次日额度'} as Record<string,string>)[job.status]||job.status}{job.lastErrorCode?` · ${memoryJobReason(job.lastErrorCode)}`:''} · {memoryJobUsage(job)}</span>{['blocked','failed','skipped'].includes(job.status)&&list&&<button className="button secondary" disabled={busy||!list.settings.useEnabled||!list.settings.extractionEnabled} onClick={()=>void mutate(()=>api.retryProjectMemoryJob(project.id,job.jobId,list.projectRevision))}>重试</button>}</div>)}{!jobs.length&&<p>暂无后台任务</p>}</details>
 </section></div>;
}
