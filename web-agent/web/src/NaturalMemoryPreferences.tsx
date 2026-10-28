import {useEffect,useRef,useState} from 'react';
import {readableError} from './api';
import {naturalMemoryApi,naturalMemoryPath,naturalPreferenceApi,type FormedPreference,type FormedChange,type NaturalMemorySettings} from './naturalMemoryApi';

export function NaturalPreferenceChangeView({value}:{value:FormedChange}){
 return <div className="strategy-source" aria-label="偏好修改记录"><p className="settings-note">{value.after?.scope==='user'?'用户全局偏好':'项目偏好'} · v{value.beforeRevision} → v{value.afterRevision}</p>
 {value.before&&<><strong>修改前</strong><pre className="strategy-diff">{value.before.body||'原内容或来源已不可用'}</pre></>}
 <strong>修改后</strong><pre className="strategy-diff">{value.after?.body||'内容或来源已不可用'}</pre>
 <p className="settings-note">{value.after?.source.private?'来源来自私有项目；全局视图隐藏项目、会话及原消息身份。':value.after?.source.available?'依据当前项目的真实用户消息保存，可核对来源。':'来源不可用。'}{value.after?.source.messageId&&<> 消息：{value.after.source.messageId}</>}</p></div>;
}
export function NaturalMemoryPreferences({projectId,busy,run}:{projectId:string;busy:boolean;run:(task:()=>Promise<void>)=>Promise<void>}){
 const base=naturalMemoryPath(projectId),generation=useRef(0);
 const [settings,setSettings]=useState<NaturalMemorySettings|null>(null),[items,setItems]=useState<FormedPreference[]>([]),[changes,setChanges]=useState<FormedChange[]>([]),[cursor,setCursor]=useState(''),[changeCursor,setChangeCursor]=useState('');
 const [detail,setDetail]=useState<FormedChange|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
 async function refresh(){const g=++generation.current;try{const [s,p,c]=await Promise.all([naturalMemoryApi.settings(base),naturalPreferenceApi.list(base),naturalPreferenceApi.changes(base)]);if(g!==generation.current)return;setSettings(s);setItems(p.items);setChanges(c.items);setCursor(p.nextCursor);setChangeCursor(c.nextCursor);setError('')}catch(e){if(g===generation.current)setError(readableError(e))}}
 useEffect(()=>{void refresh();return()=>{generation.current++}},[base]);
 return <section className="strategy-learning" aria-label="自动记忆实验"><h4>自动记忆 · 实验</h4>
 <p className="settings-note">开启后仅识别新消息中的明确长期表达偏好，后台保存，无需逐条审核或说“记住”。{projectId?'当前开关只允许项目偏好；跨项目偏好需在“用户全局”另行开启。':'当前开关只允许明确跨项目的偏好，不会将项目资料转成全局事实。'}不补扫历史，不阻塞任务。</p>
 <p className="settings-note">本阶段先保存与管理；自然记忆尚未接入后续回答，后台语义整理将在后续阶段开放。关闭停止新增，已保存内容保留；原项目记忆和人工资产仍按原设置使用。</p>
 {settings&&<label className="field-label"><input type="checkbox" checked={settings.autoEnabled} disabled={busy||!settings.automaticReady} onChange={e=>{const enabled=e.target.checked;void run(async()=>{await naturalPreferenceApi.settings(base,settings.revision,enabled);await refresh();setNotice(enabled?'自动记忆已开启，仅处理此后符合条件的新消息。':'自动记忆已关闭，已保存内容保留。')})}}/>自动形成{projectId?'项目':'用户全局'}偏好{!settings.automaticReady&&'（当前运行模式尚未开放）'}</label>}
 {error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="settings-note" role="status">{notice}</p>}
 <button type="button" className="button secondary" disabled={busy} onClick={()=>void run(refresh)}>刷新自动记忆</button>
 {items.length===0&&<p className="settings-note">本范围尚无自然形成的偏好。</p>}
 {items.map(p=><div className="strategy-source" key={p.id}><strong>{p.topic} · v{p.revision} · {({active:'已保存',undone:'已撤销',forgotten:'已遗忘',unavailable:'来源不可用'} as Record<string,string>)[p.state]||'待核对'}</strong><pre className="strategy-diff">{p.body||'无可用正文'}</pre>{p.state!=='forgotten'&&<button type="button" className="button secondary" disabled={busy} onClick={()=>void run(async()=>{await naturalPreferenceApi.forget(base,p.id,p.revision);setDetail(null);await refresh();setNotice('已遗忘正文与历史副本，保留防复活记录。')})}>遗忘此偏好</button>}</div>)}
 {cursor&&<button type="button" className="button secondary" disabled={busy} onClick={()=>void run(async()=>{const page=await naturalPreferenceApi.list(base,cursor);setItems(v=>[...v,...page.items]);setCursor(page.nextCursor)})}>更多自然偏好</button>}
 <details><summary>自然偏好变更记录</summary>{changes.map(c=><div className="strategy-source" key={c.id}><span>{({save:'保存',replace:'更正',undo:'撤销',forget:'遗忘'} as Record<string,string>)[c.kind]||'变更'} · {new Date(c.createdAt).toLocaleString()}</span><div className="strategy-toolbar"><button type="button" className="button secondary" disabled={busy} onClick={()=>void run(async()=>setDetail(await naturalPreferenceApi.change(base,c.id)))}>查看前后版本</button>{['save','replace'].includes(c.kind)&&!c.undoneBy&&<button type="button" className="button secondary" disabled={busy||!items.some(p=>p.id===c.entryId&&p.revision===c.afterRevision&&p.state==='active')} onClick={()=>void run(async()=>{await naturalPreferenceApi.undo(base,c.id,c.afterRevision);setDetail(null);await refresh();setNotice('已撤销对应变更，同一来源不会立即重新保存。')})}>撤销此变更</button>}</div></div>)}{changeCursor&&<button type="button" className="button secondary" disabled={busy} onClick={()=>void run(async()=>{const page=await naturalPreferenceApi.changes(base,changeCursor);setChanges(v=>[...v,...page.items]);setChangeCursor(page.nextCursor)})}>更多自然偏好记录</button>}</details>
 {detail&&<NaturalPreferenceChangeView value={detail}/>}</section>;
}
