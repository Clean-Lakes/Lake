import {useEffect,useRef,useState} from 'react';
import type {WatchdogMode} from '../../shared/contracts';
import {AppSelect} from './AppSelect';
import {api,readableError} from './api';

export const watchdogModes:Record<WatchdogMode,{label:string;description:string}>={
 off:{label:'关闭',description:'不再发起新的巡检，已有记录保留。'},
 observe:{label:'仅观察',description:'观察任务进展并记录发现，不向专员发送纠偏提示。'},
 guide:{label:'允许纠偏',description:'发现停滞或偏航时，提醒专员调整方向，并可恢复符合条件的临时故障。执行仍遵循当前任务权限。'},
};

export function WatchdogSettings({projectId,projectName,onBusyChange}:{projectId?:string;projectName?:string;onBusyChange?:(busy:boolean)=>void}){
 const [mode,setMode]=useState<WatchdogMode>(),[saving,setSaving]=useState<WatchdogMode>(),[error,setError]=useState(''),[reload,setReload]=useState(0);
 const mounted=useRef(false),flight=useRef(false);
 useEffect(()=>{
  mounted.current=true;const controller=new AbortController();setMode(undefined);setError('');
  if(projectId)void api.watchdogMode(projectId,controller.signal).then(value=>{
   if(!controller.signal.aborted){if(!Object.hasOwn(watchdogModes,value.mode))throw new Error('无法识别当前巡检模式');setMode(value.mode);}
  }).catch(cause=>{if(!controller.signal.aborted)setError(readableError(cause));});
  return()=>{mounted.current=false;controller.abort();};
 },[projectId,reload]);
 useEffect(()=>{onBusyChange?.(saving!==undefined);return()=>onBusyChange?.(false);},[saving,onBusyChange]);
 const change=async(next:WatchdogMode)=>{
  if(!projectId||!mode||flight.current||next===mode||!Object.hasOwn(watchdogModes,next))return;
  flight.current=true;setSaving(next);setError('');
  try{const saved=await api.setWatchdogMode(projectId,next);if(saved.mode!==next)throw new Error('巡检设置未保存，请重新读取后重试');if(mounted.current)setMode(saved.mode);}
  catch(cause){if(mounted.current)setError(readableError(cause));}
  finally{flight.current=false;if(mounted.current)setSaving(undefined);}
 };
 return <section id="watchdog-settings-panel" role="tabpanel" aria-labelledby="watchdog-settings-tab" className="model-conversation watchdog-settings">
  {!projectId?<p className="settings-note">请先选择一个项目，再配置任务巡检。</p>:<>
   <div className="watchdog-settings-project"><span>当前项目</span><strong>{projectName||'当前项目'}</strong></div>
   <p className="settings-note">统一应用于本项目的专员任务。每次执行的巡检发现仍在任务详情中查看。</p>
   <div className="watchdog-settings-card">
    <label className="field-label">巡检模式<AppSelect aria-label="项目巡检模式" value={saving??mode??''} disabled={!mode||saving!==undefined} aria-busy={!mode&&!error||saving!==undefined} aria-describedby="watchdog-mode-description" onChange={event=>void change(event.target.value as WatchdogMode)}>
     {!mode&&<option value="" disabled>{error?'读取失败':'读取中…'}</option>}
     {(Object.keys(watchdogModes) as WatchdogMode[]).map(value=><option key={value} value={value}>{watchdogModes[value].label}</option>)}
    </AppSelect></label>
    {mode&&<p id="watchdog-mode-description" className="settings-note">{watchdogModes[saving??mode].description}</p>}
   </div>
   {error&&<div className="watchdog-settings-error"><p className="form-error" role="alert">{error}</p><button type="button" className="button secondary" disabled={saving!==undefined} onClick={()=>setReload(value=>value+1)}>重新读取</button></div>}
   <p className="settings-note" role="status">{saving?'正在保存…':mode&&!error?'更改后自动保存。':''}</p>
  </>}
 </section>;
}
