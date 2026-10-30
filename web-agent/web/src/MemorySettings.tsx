import {useState} from 'react';
import {AppSelect} from './AppSelect';
import {readableError} from './api';
import {NaturalMemoryPreferences} from './NaturalMemoryPreferences';

export function MemorySettings({projectId='',projectName,onBusyChange,onProjectMemory}:{projectId?:string;projectName?:string;onBusyChange:(busy:boolean)=>void;onProjectMemory?:()=>void}){
 const [scope,setScope]=useState(projectId?'project':'user'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const activeProject=scope==='project'?projectId:'';
 async function run(task:()=>Promise<void>){setBusy(true);onBusyChange(true);setError('');try{await task()}catch(e){setError(readableError(e))}finally{setBusy(false);onBusyChange(false)}}
 return <section id="memory-settings-panel" role="tabpanel" aria-labelledby="memory-settings-tab" className="memory-settings">
 <label className="field-label">偏好适用范围<AppSelect label="记忆范围" value={scope} disabled={busy} onChange={e=>setScope(e.target.value)}>{projectId&&<option value="project">当前项目 · {projectName||projectId}</option>}<option value="user">所有项目</option></AppSelect></label>
  <p className="memory-scope-note">{activeProject?'这里的偏好只用于当前项目。':'这里的偏好可用于你的所有项目。'}</p>
 {error&&<p className="form-error" role="alert">{error}</p>}
 <NaturalMemoryPreferences key={'memory-'+activeProject} projectId={activeProject} busy={busy} run={run}/>
 {onProjectMemory&&<button type="button" className="button secondary" disabled={busy} onClick={onProjectMemory}>查看当前项目的事实与经验</button>}
 </section>;
}
