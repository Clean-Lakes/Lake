import {useEffect,useRef,useState} from 'react';
import {readableError} from './api';
import {Glyph} from './Icons';
import {naturalMemoryApi,naturalMemoryPath,naturalPreferenceApi,naturalConsolidationApi,type NaturalConflict,type ConsolidationStatus,type FormedPreference,type FormedChange,type NaturalMemorySettings} from './naturalMemoryApi';

export function NaturalPreferenceChangeView({value}:{value:FormedChange}){
 const source=value.after?.source;
 return <div className="memory-change-view" aria-label="偏好修改记录">
  {value.before&&<><strong>修改前</strong><p className="memory-change-content">{value.before.body||'此版本的内容已不可用。'}</p></>}
  <strong>修改后</strong><p className="memory-change-content">{value.after?.body||'此版本的内容已不可用。'}</p>
  <details className="memory-metadata"><summary>来源与版本</summary>
   <p>{value.after?.scope==='user'?'所有项目的偏好':'当前项目的偏好'} · 版本 {value.beforeRevision} → {value.afterRevision}</p>
   <p>{source?.private?'来自私有项目，来源详情已隐藏。':source?.available?'根据真实对话保存。':'来源已不可用。'}</p>
   {!source?.private&&source?.messageId&&<p className="memory-identifier">消息标识：{source.messageId}</p>}
  </details>
 </div>;
}

export function MemoryPreferenceControls({settings,busy,onCapture,onUse}:{settings:NaturalMemorySettings|null;busy:boolean;onCapture:(enabled:boolean)=>void;onUse:(enabled:boolean)=>void}){
 return <section className="memory-controls" aria-label="记忆开关">
  <label className="memory-control"><span><strong>自动积累偏好</strong><span>从今后的对话中保存明确的长期偏好。</span></span><input aria-label="自动积累偏好" type="checkbox" checked={settings?.autoEnabled??false} disabled={busy||!settings?.automaticReady} onChange={e=>onCapture(e.target.checked)}/></label>
  <label className="memory-control"><span><strong>回答时使用偏好</strong><span>让回答参考这里保存的偏好。</span></span><input aria-label="回答时使用偏好" type="checkbox" checked={settings?.recallSettings?.useEnabled??false} disabled={busy||!settings} onChange={e=>onUse(e.target.checked)}/></label>
  <p className="memory-control-hint">关闭开关会保留已保存的偏好。{settings&&!settings.automaticReady&&'当前运行模式暂不支持自动积累。'}</p>
 </section>;
}

export function MemoryPreferenceItem({value,busy,onForget}:{value:FormedPreference;busy:boolean;onForget:(value:FormedPreference)=>void}){
 const [confirmRevision,setConfirmRevision]=useState<number|null>(null),cancel=useRef<HTMLButtonElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const confirm=confirmRevision!==null,changed=confirm&&confirmRevision!==value.revision;
 useEffect(()=>{if(confirm)cancel.current?.focus()},[confirm]);
 function dismiss(){setConfirmRevision(null);trigger.current?.focus()}
 const sources=value.sources??[value.source],available=sources.filter(source=>source.available).length;
 return <article className="memory-preference-item">
  {value.body?<p className="memory-preference-content">{value.body}</p>:<p className="settings-note">此偏好的内容暂不可用。</p>}
  {value.state!=='active'&&<p className="memory-item-status">{value.state==='conflict'?'存在不同说法，暂不用于回答。':'来源暂不可用，已停止使用。'}</p>}
  <div className="memory-item-actions"><details className="memory-metadata"><summary>来源与版本</summary><p>版本 {value.revision} · {available} 条可核对的对话来源</p>{sources.some(source=>source.private)&&<p>私有项目的来源详情已隐藏。</p>}</details><button ref={trigger} type="button" className="memory-text-button" disabled={busy} onClick={()=>setConfirmRevision(value.revision)}>遗忘</button></div>
  {confirm&&<div className="memory-forget-confirm" role="group" aria-label="确认遗忘偏好" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(!busy)dismiss()}}}>
   <p>{changed?'这条偏好已经更新，请取消后重新查看。':'遗忘这条偏好？正文及历史副本会被删除，无法撤销。'}</p><div className="memory-toolbar"><button ref={cancel} type="button" className="button secondary" disabled={busy} onClick={dismiss}>取消</button><button type="button" className="button secondary danger" disabled={busy||changed} onClick={()=>{if(value.revision===confirmRevision)onForget(value)}}>确认遗忘</button></div>
  </div>}
 </article>;
}

export function MemoryConsolidationDetails({value}:{value:ConsolidationStatus}){
 return <details className="memory-support-details"><summary>整理状态</summary>
  <dl className="memory-activity"><div><dt>待整理</dt><dd>{value.captured}</dd></div><div><dt>已整理</dt><dd>{value.processed}</dd></div><div><dt>暂缓</dt><dd>{value.deferred}</dd></div><div><dt>已撤回</dt><dd>{value.withdrawn}</dd></div></dl>
  {value.deferred>0&&<p className="settings-note">暂缓的记录尚未整理完成，不影响正常对话。</p>}
 </details>;
}

export function NaturalMemoryPreferences({projectId,busy,run}:{projectId:string;busy:boolean;run:(task:()=>Promise<void>)=>Promise<void>}){
 const base=naturalMemoryPath(projectId),generation=useRef(0);
 const [settings,setSettings]=useState<NaturalMemorySettings|null>(null),[items,setItems]=useState<FormedPreference[]>([]),[changes,setChanges]=useState<FormedChange[]>([]),[cursor,setCursor]=useState(''),[changeCursor,setChangeCursor]=useState('');
 const [activity,setActivity]=useState<ConsolidationStatus|null>(null),[conflicts,setConflicts]=useState<NaturalConflict[]>([]),[conflictCursor,setConflictCursor]=useState('');
 const [detail,setDetail]=useState<FormedChange|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true);
 async function refresh(){const g=++generation.current;setLoading(true);try{const [s,p,c,a,f]=await Promise.all([naturalMemoryApi.settings(base),naturalPreferenceApi.list(base),naturalPreferenceApi.changes(base),naturalConsolidationApi.status(base),naturalConsolidationApi.conflicts(base)]);if(g!==generation.current)return;setSettings(s);setActivity(a);setConflicts(f.items);setConflictCursor(f.nextCursor);setItems(p.items);setChanges(c.items);setCursor(p.nextCursor);setChangeCursor(c.nextCursor);setError('')}catch(e){if(g===generation.current)setError(readableError(e))}finally{if(g===generation.current)setLoading(false)}}
 useEffect(()=>{void refresh();return()=>{generation.current++}},[base]);
 const saved=items.filter(item=>!['forgotten','undone'].includes(item.state)),removed=items.filter(item=>['forgotten','undone'].includes(item.state));
 const pending=conflicts.filter(item=>item.status==='pending'&&!item.stale&&item.source.available),settled=conflicts.filter(item=>!pending.includes(item));
 return <section className="memory-preferences" aria-label="自然偏好设置">
  <MemoryPreferenceControls settings={settings} busy={busy||loading} onCapture={enabled=>void run(async()=>{await naturalPreferenceApi.settings(base,settings!.revision,enabled);await refresh();setNotice(enabled?'已开启自动积累，只处理今后的对话。':'已停止自动积累，保存内容保留。')})} onUse={enabled=>void run(async()=>{await naturalPreferenceApi.recallSettings(base,settings!.recallSettings?.revision??0,enabled);await refresh();setNotice(enabled?'回答时将参考这里的偏好。':'已停止使用这里的偏好，保存内容保留。')})}/>
  {error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="settings-note" role="status">{notice}</p>}
  {pending.length>0&&<section className="memory-attention" aria-label="需要确认的偏好"><h4>有些偏好需要你确认</h4><p className="settings-note">发现了不同说法，相关偏好已暂停使用。要更改偏好，也可以直接在对话中说明。</p>{pending.map(c=><div className="memory-conflict" key={c.id}>{items.find(p=>p.id===c.entryId)?.body&&<><strong>原偏好</strong><p>{items.find(p=>p.id===c.entryId)!.body}</p></>}<strong>新的说法</strong><p>{c.body}</p><button type="button" className="button secondary" disabled={busy} onClick={()=>void run(async()=>{await naturalConsolidationApi.reject(base,c.id,c.currentRevision);await refresh();setNotice('已保留原偏好。')})}>保留原偏好</button></div>)}</section>}
  <section className="memory-saved" aria-label="已保存的偏好"><header className="memory-section-header"><h4>已保存的偏好</h4><button type="button" className="icon-button" aria-label="刷新记忆" title="刷新记忆" disabled={busy||loading} onClick={()=>void run(refresh)}><Glyph name="refresh" size={15}/></button></header>
   {!settings?(loading?<p className="settings-note" role="status">正在读取记忆…</p>:null):saved.length===0&&<p className="memory-empty">{cursor?'当前页没有可用偏好，可继续加载。':settings.automaticReady?'还没有保存偏好。开启自动积累后，正常交流即可。':'还没有保存偏好。'}</p>}
   {saved.map(value=><MemoryPreferenceItem key={value.id} value={value} busy={busy||loading} onForget={item=>void run(async()=>{await naturalPreferenceApi.forget(base,item.id,item.revision);setDetail(null);await refresh();setNotice('已遗忘这条偏好及其历史正文。')})}/>)}
   {cursor&&<button type="button" className="button secondary" disabled={busy||loading} onClick={()=>void run(async()=>{const page=await naturalPreferenceApi.list(base,cursor);setItems(v=>[...v,...page.items]);setCursor(page.nextCursor)})}>加载更多偏好</button>}
  </section>

  <div className="memory-support">
   <details className="memory-support-details"><summary>修改记录</summary>
    {!changes.length&&!removed.length&&<p className="settings-note">还没有修改记录。</p>}
    {changes.map(c=><div className="memory-change-row" key={c.id}><span>{({save:'保存偏好',replace:'更正偏好',undo:'撤销修改',forget:'遗忘偏好',merge:'合并重复偏好'} as Record<string,string>)[c.kind]||'修改偏好'} · {new Date(c.createdAt).toLocaleString()}</span><div className="memory-toolbar"><button type="button" className="memory-text-button" disabled={busy} onClick={()=>void run(async()=>setDetail(await naturalPreferenceApi.change(base,c.id)))}>查看变化</button>{['save','replace','merge'].includes(c.kind)&&!c.undoneBy&&<button type="button" className="memory-text-button" disabled={busy||!items.some(p=>p.id===c.entryId&&p.revision===c.afterRevision&&p.state==='active')} onClick={()=>void run(async()=>{await naturalPreferenceApi.undo(base,c.id,c.afterRevision);setDetail(null);await refresh();setNotice('已撤销这次修改。')})}>撤销这次修改</button>}</div>{detail?.id===c.id&&<><NaturalPreferenceChangeView value={detail}/><button type="button" className="memory-text-button" onClick={()=>setDetail(null)}>收起变化</button></>}</div>)}
    {changeCursor&&<button type="button" className="button secondary" disabled={busy} onClick={()=>void run(async()=>{const page=await naturalPreferenceApi.changes(base,changeCursor);setChanges(v=>[...v,...page.items]);setChangeCursor(page.nextCursor)})}>更多修改记录</button>}
    {removed.length>0&&<details className="memory-metadata"><summary>已撤销和遗忘的偏好</summary>{removed.map(item=><p key={item.id}>{item.state==='forgotten'?'已遗忘，历史正文已删除。':'已撤销，不再用于回答。'}{item.state!=='forgotten'&&item.body&&<span>{item.body}</span>}</p>)}</details>}
    {(settled.length>0||conflictCursor)&&<details className="memory-metadata"><summary>其他矛盾记录</summary>{settled.map(c=><div key={c.id}><p>{c.stale?'原偏好已有更新':!c.source.available?'来源已不可用':'已处理'}</p>{c.body&&<p>{c.body}</p>}</div>)}{conflictCursor&&<button type="button" className="button secondary" disabled={busy} onClick={()=>void run(async()=>{const page=await naturalConsolidationApi.conflicts(base,conflictCursor);setConflicts(v=>[...v,...page.items]);setConflictCursor(page.nextCursor)})}>更多矛盾记录</button>}</details>}
   </details>
   {activity&&<MemoryConsolidationDetails value={activity}/>}
   <details className="memory-support-details"><summary>记忆如何工作</summary><ul><li>只积累开启后的新对话，不补扫历史。</li><li>自动积累与回答使用独立控制，各自默认关闭。</li><li>当前明确要求优先；项目偏好优先于所有项目的偏好。所有项目的偏好需要在对应范围单独开启。</li><li>偏好只影响回答方式，不改变工具权限。目前用于普通对话和 Pilot 协调回复，专员与工作流不继承。</li></ul></details>
  </div>
 </section>;
}
