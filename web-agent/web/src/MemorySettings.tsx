import {useState} from 'react';
import {AppSelect} from './AppSelect';
import {readableError} from './api';
import {NaturalMemoryPreferences} from './NaturalMemoryPreferences';
import {NaturalMemoryFoundation} from './NaturalMemoryFoundation';
import {StrategySettings} from './StrategySettings';
import './strategySettings.css';

export function MemorySettings({projectId='',projectName,onBusyChange}:{projectId?:string;projectName?:string;onBusyChange:(busy:boolean)=>void}){
 const [scope,setScope]=useState(projectId?'project':'user'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[history,setHistory]=useState(false);
 const activeProject=scope==='project'?projectId:'';
 async function run(task:()=>Promise<void>){setBusy(true);onBusyChange(true);setError('');try{await task()}catch(e){setError(readableError(e))}finally{setBusy(false);onBusyChange(false)}}
 return <section id="memory-settings-panel" role="tabpanel" aria-labelledby="memory-settings-tab" className="strategy-settings">
 <p className="settings-note">自然积累明确长期偏好，空闲时增量整理，保留来源与修改历史。新偏好的回答复用仍待后续阶段开放。</p>
 <label className="field-label">管理范围<AppSelect label="记忆范围" value={scope} disabled={busy} onChange={e=>setScope(e.target.value)}>{projectId&&<option value="project">当前项目 · {projectName||projectId}</option>}<option value="user">用户全局 · 所有项目</option></AppSelect></label>
 {error&&<p className="form-error" role="alert">{error}</p>}
 <NaturalMemoryPreferences key={'memory-'+activeProject} projectId={activeProject} busy={busy} run={run}/>
 <details open={history} onToggle={e=>setHistory(e.currentTarget.open)}><summary onClick={e=>{if(busy)e.preventDefault()}}>历史资产与兼容管理</summary>
 <p className="settings-note">保留旧正文、采用条件、来源、候选和实验报告。旧在线纠错、候选提取与新增实验已退役；这里的管理不代表重新启用。</p>
 {history&&<><NaturalMemoryFoundation key={'carry-'+activeProject} projectId={activeProject} busy={busy} run={run}/><StrategySettings key={'legacy-'+projectId} projectId={projectId} projectName={projectName} onBusyChange={v=>{setBusy(v);onBusyChange(v)}}/></>}
 </details></section>;
}
