import {useId,useRef,useState} from 'react';
import type {SessionSnapshot} from '../../shared/contracts';
import {api,readableError} from './api';
export function SREModeToggle({snapshot,onUpdated,disabled,disabledReason}:{snapshot:SessionSnapshot;onUpdated:()=>Promise<unknown>;disabled?:boolean;disabledReason?:string}){
 const hintId=useId();
 const saving=useRef(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');if(snapshot.ai?.profile&&snapshot.ai.profile!=='core')return null;
 const enabled=!!snapshot.sre?.enabled;
 const hint=busy?'正在保存 SRE 协作设置…':disabled?(disabledReason||'当前暂不能切换 SRE 协作，请稍后再试。'):'实验性功能，仍在测试中。在此项目启用四个专员、Plan 与独立验证。';
 return <><button type="button" className="composer-permission-button sre-mode-toggle" aria-pressed={enabled} aria-busy={busy} aria-disabled={!!disabled||busy} aria-describedby={hintId} disabled={disabled} title={hint} onClick={()=>{if(disabled||saving.current)return;saving.current=true;setBusy(true);setError('');void api.setSREEnabled(snapshot.session.projectId,!enabled).then(()=>onUpdated()).catch(e=>setError(readableError(e))).finally(()=>{saving.current=false;setBusy(false)})}}><span>SRE 协作</span><span className="sre-experimental-badge">实验型</span></button><span id={hintId} className="visually-hidden" role="status">{hint}</span>{error&&<span role="alert" className="sre-toggle-error">{error}</span>}</>
}
