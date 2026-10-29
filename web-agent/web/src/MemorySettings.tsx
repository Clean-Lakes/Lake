import {useState} from 'react';
import {AppSelect} from './AppSelect';
import {readableError} from './api';
import {NaturalMemoryPreferences} from './NaturalMemoryPreferences';

export function MemorySettings({projectId='',projectName,onBusyChange,onProjectMemory}:{projectId?:string;projectName?:string;onBusyChange:(busy:boolean)=>void;onProjectMemory?:()=>void}){
 const [scope,setScope]=useState(projectId?'project':'user'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const activeProject=scope==='project'?projectId:'';
 async function run(task:()=>Promise<void>){setBusy(true);onBusyChange(true);setError('');try{await task()}catch(e){setError(readableError(e))}finally{setBusy(false);onBusyChange(false)}}
 return <section id="memory-settings-panel" role="tabpanel" aria-labelledby="memory-settings-tab" className="memory-settings">
 <p className="settings-note">自然积累明确长期偏好，空闲时增量整理，保留来源与修改历史。使用独立开启后按用户/项目范围提供表达偏好，当前明确要求优先。</p>
 <label className="field-label">管理范围<AppSelect label="记忆范围" value={scope} disabled={busy} onChange={e=>setScope(e.target.value)}>{projectId&&<option value="project">当前项目 · {projectName||projectId}</option>}<option value="user">用户全局 · 所有项目</option></AppSelect></label>
 {error&&<p className="form-error" role="alert">{error}</p>}
 <NaturalMemoryPreferences key={'memory-'+activeProject} projectId={activeProject} busy={busy} run={run}/>
 {onProjectMemory&&<button type="button" className="button secondary" disabled={busy} onClick={onProjectMemory}>项目事实与历史经验</button>}
 </section>;
}
