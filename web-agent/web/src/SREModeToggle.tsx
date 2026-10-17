import {useId,useState} from 'react';
import type {SessionSnapshot} from '../../shared/contracts';
import {api,readableError} from './api';
export function SREModeToggle({snapshot,onUpdated,disabled}:{snapshot:SessionSnapshot;onUpdated:()=>Promise<unknown>;disabled?:boolean}){
 const hintId=useId();
 const [busy,setBusy]=useState(false),[error,setError]=useState('');if(snapshot.ai?.profile&&snapshot.ai.profile!=='core')return null;
 const enabled=!!snapshot.sre?.enabled;
 return <><button type="button" className="composer-permission-button sre-mode-toggle" aria-pressed={enabled} aria-busy={busy} aria-describedby={hintId} disabled={disabled||busy} title="实验性功能，仍在测试中。在此项目启用四个专员、Plan 与独立验证。" onClick={()=>{setBusy(true);setError('');void api.setSREEnabled(snapshot.session.projectId,!enabled).then(()=>onUpdated()).catch(e=>setError(readableError(e))).finally(()=>setBusy(false))}}><span>SRE 协作</span><span className="sre-experimental-badge">实验型</span></button><span id={hintId} className="visually-hidden">SRE 协作为实验性功能，仍在测试中。</span>{error&&<span role="alert" className="sre-toggle-error">{error}</span>}</>
}
