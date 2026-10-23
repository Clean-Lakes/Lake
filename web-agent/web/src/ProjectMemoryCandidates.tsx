import {useEffect,useState} from 'react';
import type {MemoryCandidate,ProjectMemoryEntry,Resource} from '../../shared/contracts';
import {api,readableError} from './api';
import {MemoryScopeFields} from './ProjectMemoryDetail';
import {memoryDraft,memoryTime} from './projectMemoryState';

export function ProjectMemoryCandidates({projectId,candidates,resources,projectRevision,onChanged}:{projectId:string;candidates:MemoryCandidate[];resources:Resource[];projectRevision:number;onChanged:()=>void}){
 const [selected,setSelected]=useState<MemoryCandidate|null>(null);
 const [draft,setDraft]=useState(memoryDraft());const [old,setOld]=useState<ProjectMemoryEntry|null>(null);
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 useEffect(()=>{if(!selected){setOld(null);return}const controller=new AbortController();setOld(null);api.projectMemory(projectId,selected.baseKey,false,controller.signal).then(value=>{if(!controller.signal.aborted)setOld(value)}).catch(()=>{});return()=>controller.abort()},[projectId,selected]);
 async function decide(action:'accept'|'reject'){
  if(!selected)return;setBusy(true);setError('');
  try{await api.decideMemoryCandidate(projectId,selected.candidateId,{action,expectedProjectRevision:projectRevision,expectedCandidateHash:selected.candidateHash,...(action==='accept'?{scopeKind:draft.scopeKind,resourceIds:draft.resourceIds,knowledgeKind:draft.knowledgeKind,subject:draft.subject}:{})});setSelected(null);onChanged()}catch(err){setError(readableError(err))}finally{setBusy(false)}
 }
 return <section className="memory-candidates" aria-label="待复核记忆">
  {!selected?<>{candidates.length?candidates.map(candidate=><button className="memory-list-row" key={candidate.candidateId} onClick={()=>{setSelected(candidate);setDraft(memoryDraft({...candidate.proposal,key:candidate.baseKey}));setError('')}}><strong>{candidate.proposal.description||candidate.baseKey}</strong><small>{candidate.reason==='conflict'?'与已有记录冲突':'需要确认范围与内容'} · {memoryTime(candidate.createdAt)}</small></button>):<p className="memory-empty">暂无待复核候选</p>}</>:<>
   <header><h3>复核记忆</h3><button className="button secondary" onClick={()=>setSelected(null)}>返回列表</button></header>
   <p className="modal-description">接受只确认这条记录的适用性，不会刷新采样时间或证明当前现场状态。</p>
   <div className="memory-compare">{old&&<section><h4>原记录 · 版本 {old.revision}</h4><p>{old.body}</p></section>}<section><h4>新候选</h4><strong>{selected.proposal.description}</strong><p>{selected.proposal.body}</p></section></div>
   <MemoryScopeFields draft={draft} resources={resources} onChange={setDraft}/>
   {error&&<p className="form-error" role="alert">{error}</p>}
   <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={()=>void decide('reject')}>拒绝</button><button className="button primary" disabled={busy||draft.scopeKind==='resources'&&!draft.resourceIds.length} onClick={()=>void decide('accept')}>接受此记录</button></div>
  </>}
 </section>;
}
