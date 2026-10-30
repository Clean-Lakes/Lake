import {useState} from 'react';
import {readableError} from './api';
import {naturalNoticeBase,naturalPreferenceApi,type NaturalNotice,type FormedChange} from './naturalMemoryApi';
import {NaturalPreferenceChangeView} from './NaturalMemoryPreferences';
export function NaturalMemoryNotice({notices}:{notices:NaturalNotice[]}){
 const [hidden,setHidden]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[details,setDetails]=useState<FormedChange[]>([]),[viewBatch,setViewBatch]=useState('');
 const pending=notices.filter(n=>!hidden.includes(n.changeId));const first=pending[0];if(!first)return null;
 const batch=first.batchId?pending.filter(n=>n.batchId===first.batchId):[first],identity=first.batchId||first.changeId;
 async function act(task:()=>Promise<void>){setBusy(true);setError('');try{await task()}catch(e){setError(readableError(e))}finally{setBusy(false)}}
 async function view(){setDetails(await Promise.all(batch.map(n=>naturalPreferenceApi.change(naturalNoticeBase(n.scope),n.changeId))));setViewBatch(identity)}
 async function undo(n:NaturalNotice){await naturalPreferenceApi.undo(naturalNoticeBase(n.scope),n.changeId,n.revision);setHidden(v=>[...v,n.changeId]);setDetails(v=>v.filter(d=>d.id!==n.changeId))}
 return <aside className="natural-memory-notice" aria-label="偏好更新"><div className="system-banner" role="status"><span>已更新{batch.length===1?(first.scope==='user'?'用户':'项目'):''}偏好{batch.length>1&&` · ${batch.length} 项`} · 实验</span><button disabled={busy} onClick={()=>void act(view)}>查看</button><button disabled={busy} onClick={()=>void act(async()=>{if(batch.length===1)await undo(first);else await view()})}>撤销</button><button disabled={busy} onClick={()=>void act(async()=>{for(const n of batch){await naturalPreferenceApi.dismiss(naturalNoticeBase(n.scope),n.changeId);setHidden(v=>[...v,n.changeId])}setDetails([])})}>收起</button></div>{error&&<p className="form-error" role="alert">{error}</p>}
 {viewBatch===identity&&details.length>0&&<div className="natural-memory-details">{batch.length>1&&<p className="settings-note">本批有多项更新，可分别查看、撤销；有后续修改时会保留新版本并提示冲突。</p>}{details.map(d=><div key={d.id}><NaturalPreferenceChangeView value={d}/>{batch.find(n=>n.changeId===d.id)&&<button type="button" className="button secondary" disabled={busy} onClick={()=>void act(async()=>{const n=batch.find(n=>n.changeId===d.id);if(n)await undo(n)})}>撤销此项更新</button>}</div>)}<button type="button" className="button secondary" onClick={()=>setDetails([])}>关闭详情</button></div>}</aside>;
}
