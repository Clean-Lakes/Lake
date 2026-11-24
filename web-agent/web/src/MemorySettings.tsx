import {useState} from 'react';
import {AppSelect} from './AppSelect';
import {readableError} from './api';
import {NativeMemorySettings} from './NativeMemorySettings';
import {NaturalMemoryPreferences} from './NaturalMemoryPreferences';
import {WorkspaceSettingSection} from './WorkspacePage';

export function MemorySettings({projectId='',projectName,onBusyChange,onProjectMemory,memoryEngine}:{projectId?:string;projectName?:string;onBusyChange:(busy:boolean)=>void;onProjectMemory?:()=>void;memoryEngine?:'layered'}){
 const [scope,setScope]=useState(projectId?'project':'user'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const activeProject=scope==='project'?projectId:'';
 async function run(task:()=>Promise<void>){setBusy(true);onBusyChange(true);setError('');try{await task()}catch(e){setError(readableError(e))}finally{setBusy(false);onBusyChange(false)}}
 if(memoryEngine==='layered')return <NativeMemorySettings projectId={projectId} projectName={projectName} onBusyChange={onBusyChange}/>;
 return <section id="memory-settings-panel" role="tabpanel" aria-labelledby="memory-settings-tab" className="memory-settings">
 <WorkspaceSettingSection id="legacy-memory-scope-title" title="记忆范围">
  <div className="workspace-setting-card workspace-setting-row">
   <div className="workspace-setting-copy">
    <strong>偏好适用范围</strong>
    <p className="settings-note">{activeProject?'这里的偏好只用于当前项目。':'这里的偏好可用于你的所有项目。'}</p>
   </div>
   <AppSelect label="记忆范围" value={scope} disabled={busy} onChange={e=>setScope(e.target.value)}>
    {projectId&&<option value="project">当前项目 · {projectName||projectId}</option>}
    <option value="user">所有项目</option>
   </AppSelect>
  </div>
 </WorkspaceSettingSection>
 {error&&<p className="form-error" role="alert">{error}</p>}
 <NaturalMemoryPreferences key={'memory-'+activeProject} projectId={activeProject} busy={busy} run={run}/>
 {onProjectMemory&&<WorkspaceSettingSection id="legacy-project-memory-title" title="项目记忆">
  <div className="workspace-setting-card workspace-setting-row">
   <div className="workspace-setting-copy"><strong>事实与经验</strong></div>
   <button type="button" className="button secondary" disabled={busy} onClick={onProjectMemory}>查看当前项目的事实与经验</button>
  </div>
 </WorkspaceSettingSection>}
 </section>;
}
