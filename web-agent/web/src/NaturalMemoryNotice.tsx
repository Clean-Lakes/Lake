import {useState} from 'react';
import {readableError} from './api';
import {naturalNoticeBase,naturalPreferenceApi,type NaturalNotice,type FormedChange} from './naturalMemoryApi';
import {NaturalPreferenceChangeView} from './NaturalMemoryPreferences';
export function NaturalMemoryNotice({notices}:{notices:NaturalNotice[]}){
 const [hidden,setHidden]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[detail,setDetail]=useState<FormedChange|null>(null);
 const notice=notices.find(n=>!hidden.includes(n.changeId));if(!notice)return null;
 const base=naturalNoticeBase(notice.scope);
 async function act(task:()=>Promise<void>){setBusy(true);setError('');try{await task()}catch(e){setError(readableError(e))}finally{setBusy(false)}}
 return <aside className="natural-memory-notice" aria-label="偏好更新"><div className="system-banner" role="status"><span>已更新{notice.scope==='user'?'用户':'项目'}偏好 · 实验</span><button disabled={busy} onClick={()=>void act(async()=>setDetail(await naturalPreferenceApi.change(base,notice.changeId)))}>查看</button><button disabled={busy} onClick={()=>void act(async()=>{await naturalPreferenceApi.undo(base,notice.changeId,notice.revision);setHidden(v=>[...v,notice.changeId]);setDetail(null)})}>撤销</button><button disabled={busy} onClick={()=>void act(async()=>{await naturalPreferenceApi.dismiss(base,notice.changeId);setHidden(v=>[...v,notice.changeId]);setDetail(null)})}>收起</button></div>{error&&<p className="form-error" role="alert">{error}</p>}{detail?.id===notice.changeId&&<div className="strategy-settings"><NaturalPreferenceChangeView value={detail}/><button type="button" className="button secondary" onClick={()=>setDetail(null)}>关闭详情</button></div>}</aside>;
}
