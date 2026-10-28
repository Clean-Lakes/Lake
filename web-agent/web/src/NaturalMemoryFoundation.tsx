import {useEffect,useRef,useState} from 'react';
import {readableError} from './api';
import {naturalMemoryApi,naturalMemoryPath,type NaturalLegacy,type NaturalPreference,type NaturalPreview,type NaturalChange,type NaturalMemorySettings} from './naturalMemoryApi';
const reasons:Record<string,string>={method_requires_export:'方法类内容可在旧入口导出为 Skill',source_unavailable:'来源不可用',rejected:'已拒绝',not_adopted:'未采用或已停用',review_required:'需要复核适用条件'};
const states:Record<string,string>={mapped:'已纳入记忆管理',undone:'已撤销承接',conflict:'旧内容或条件已有变化，待核对',unavailable:'来源已失效'};
export function NaturalMemoryFoundation({projectId,busy,run}:{projectId:string;busy:boolean;run:(task:()=>Promise<void>)=>Promise<void>}){
 const base=naturalMemoryPath(projectId),generation=useRef(0);
 const [settings,setSettings]=useState<NaturalMemorySettings|null>(null),[legacy,setLegacy]=useState<NaturalLegacy[]>([]),[entries,setEntries]=useState<NaturalPreference[]>([]),[changes,setChanges]=useState<NaturalChange[]>([]);
 const [preview,setPreview]=useState<NaturalPreview|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [memories,setMemories]=useState<{key:string;description:string;revision:number}[]>([]);
 const [cursors,setCursors]=useState({legacy:'',entries:'',changes:''});
 async function refresh(){
  const current=++generation.current;
  const [s,l,p,c,m]=await Promise.all([naturalMemoryApi.settings(base),naturalMemoryApi.legacy(base),naturalMemoryApi.preferences(base),naturalMemoryApi.changes(base),naturalMemoryApi.projectEntries(base)]).catch(e=>{if(current!==generation.current)return [null,null,null,null,null] as const;throw e;});
  if(!s||!l||!p||!c||!m)return;
  if(current!==generation.current)return;
  setSettings(s);setLegacy(l.items);setEntries(p.items);setChanges(c.items);setMemories(m.items);setCursors({legacy:l.nextCursor,entries:p.nextCursor,changes:c.nextCursor});setError('');
 }
 useEffect(()=>{void refresh().catch(e=>setError(readableError(e)));return()=>{generation.current++;};},[base]);
 return <details className="strategy-learning"><summary>旧偏好承接 · 实验</summary>
 <p className="settings-note">将已采用的偏好纳入记忆管理，保留原正文、版本和适用条件。当前仍按原设置使用；撤销承接只撤销管理归属，不会停用原偏好。自然形成与空闲整理见上方自动记忆开关。</p>
 {settings&&<p className="settings-note">偏好实际应用：{settings.preferenceSettings.effectiveUseEnabled?'开启':'关闭'}。{settings.projectMemorySettings&&<>项目记忆使用：{settings.projectMemorySettings.useEnabled?'开启':'关闭'}；原有项目提炼：{settings.projectMemorySettings.extractionEnabled?'开启':'关闭'}。</>}</p>}
 {error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="settings-note" role="status">{notice}</p>}
 <button type="button" className="button secondary" disabled={busy} onClick={()=>void run(refresh)}>刷新记忆内容</button>
 <h4>旧偏好与方法</h4>{legacy.length===0&&<p className="settings-note">本范围暂无旧资产。</p>}
 {legacy.map(item=><div className="strategy-source" key={item.id}><strong>{item.title||'内容不可用'} · v{item.contentRevision}</strong><small>{item.linkState==='mapped'?'已承接':item.eligible?'原采用范围与条件保留':reasons[item.reason]||'需在旧管理入口核对'}</small><button type="button" className="button secondary" disabled={busy||!item.eligible||item.linkState==='mapped'} onClick={()=>void run(async()=>{setNotice('');setPreview(await naturalMemoryApi.preview(base,item.id));})}>预览承接</button></div>)}
 {cursors.legacy&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{const p=await naturalMemoryApi.legacy(base,cursors.legacy);setLegacy(v=>[...v,...p.items]);setCursors(v=>({...v,legacy:p.nextCursor}));})}>更多旧内容</button>}
 {preview&&<section className="strategy-source" aria-label="确认记忆承接"><h4>{preview.title} · v{preview.contentRevision}</h4><pre className="strategy-diff">{preview.body}</pre>
 <p className="settings-note">范围：{preview.scope.kind==='user'?'用户全局':'当前项目'}；场景：{preview.applicability.profiles?.join('、')||'沿用原不限条件'}；资源类型：{preview.applicability.resourceKinds?.join('、')||'沿用原不限条件'}；领域标签：{preview.applicability.domainTags?.join('、')||'不限'}。</p>
 <p className="settings-note">{preview.reuse.general?'在符合原条件的任务使用。':'关键词：'+(preview.reuse.keywords.join('、')||'无通用匹配条件')+'。'}{preview.reuse.validUntil&&'有效期截止：'+new Date(preview.reuse.validUntil).toLocaleString()+'。'}互斥与原停用覆盖继续生效。</p>
 <details><summary>原采用条件与限制</summary><p className="settings-note">排序优先级：{preview.binding.priority}；互斥组：{preview.binding.exclusionGroup||'无'}。</p><p className="settings-note">{preview.assessment.conditions||'未填写额外前提'}</p><p className="settings-note">{preview.assessment.evidence||'效果尚未验证'}</p><p className="settings-note">{preview.assessment.limitations||'使用前仍需核实当前条件'}</p></details>
 <div className="strategy-toolbar"><button type="button" className="button secondary" disabled={busy} onClick={()=>setPreview(null)}>返回列表</button><button type="button" className="button secondary" disabled={busy||!preview.eligible} onClick={()=>void run(async()=>{await naturalMemoryApi.carry(base,preview);setPreview(null);await refresh();setNotice('已纳入记忆管理；原偏好使用设置未改变。');})}>确认承接此版本</button></div></section>}
 <h4>已承接的偏好</h4>{entries.length===0&&<p className="settings-note">尚未承接偏好。</p>}{entries.map(e=><p className="settings-note" key={e.id}>{e.title||'内容不可用'} · v{e.contentRevision} · {states[e.state]||'待核对'}</p>)}
 {cursors.entries&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{const p=await naturalMemoryApi.preferences(base,cursors.entries);setEntries(v=>[...v,...p.items]);setCursors(v=>({...v,entries:p.nextCursor}));})}>更多已承接偏好</button>}
 {projectId&&<><h4>原有项目记忆</h4>{memories.length===0?<p className="settings-note">本范围暂无项目记忆。</p>:memories.map(e=><p className="settings-note" key={e.key}>{e.description} · v{e.revision}</p>)}<p className="settings-note">此处显示前 20 条，完整内容、编辑与遗忘仍在项目记忆入口。</p></>}
 <h4>承接记录</h4>{changes.map(c=><div className="strategy-source" key={c.id}><small>{c.kind==='carry'?'承接':'撤销承接'} · {new Date(c.createdAt).toLocaleString()}</small>{c.kind==='carry'&&!c.undoneBy&&<button type="button" className="button secondary" disabled={busy||!entries.some(e=>e.id===c.assetId&&e.state==='mapped'&&e.revision===c.revision)} onClick={()=>void run(async()=>{const entry=entries.find(e=>e.id===c.assetId);if(!entry)return;await naturalMemoryApi.undo(base,c.id,entry.revision);await refresh();setNotice('已撤销承接，原正文和使用设置保留。');})}>撤销承接</button>}</div>)}
 {cursors.changes&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{const p=await naturalMemoryApi.changes(base,cursors.changes);setChanges(v=>[...v,...p.items]);setCursors(v=>({...v,changes:p.nextCursor}));})}>更多承接记录</button>}
 </details>;
}
