import {useEffect,useId,useRef,useState} from 'react';
import type {PilotSettings,SessionSnapshot} from '../../shared/contracts';
import {api,readableError} from './api';
import {Glyph} from './Icons';
import {PilotAutoAdvance} from './PilotAutoAdvance';
import {SREModeToggle} from './SREModeToggle';

export function LakePilotControl({snapshot,onUpdated,disabled,disabledReason,autoAdvanceDisabled=false}:{snapshot:SessionSnapshot;onUpdated:()=>Promise<unknown>;disabled?:boolean;disabledReason?:string;autoAdvanceDisabled?:boolean}){
 const project=snapshot.session.projectId, incoming=snapshot.sre?.pilot;
 const hintId=useId(),saving=useRef(false),current=useRef(project);
 current.current=project;
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const [saved,setSaved]=useState<{project:string;settings:PilotSettings}|null>(null);
 useEffect(()=>{current.current=project;return()=>{current.current=''}},[project]);
 useEffect(()=>{setError('')},[project]);
 if(snapshot.ai?.profile&&snapshot.ai.profile!=='core')return null;
 if(!incoming)return <SREModeToggle snapshot={snapshot} onUpdated={onUpdated} disabled={disabled} disabledReason={disabledReason}/>;
 const settings=saved?.project===project&&saved.settings.revision>incoming.revision?saved.settings:incoming;
 const hint=busy?'正在保存 Lake Pilot 设置…':disabled?(disabledReason||'本轮运行中，结束后可切换 Lake Pilot。'):'Lake Pilot · 专员协作与分层操作，对当前项目生效。';
 const save=async(updates:{enabled?:boolean;autoAdvance?:boolean})=>{
  if(saving.current)return false;saving.current=true;setBusy(true);setError('');
  try{const value=await api.setPilotSettings(project,{...updates,expectedRevision:settings.revision});if(current.current===project){setSaved({project,settings:value});await onUpdated();return true}return false}
  catch(e){if(current.current===project){setError(readableError(e));void onUpdated().catch(()=>{})}return false}
  finally{saving.current=false;if(current.current===project)setBusy(false)}
 };
 return <><span className="pilot-control">
  <button type="button" className="composer-permission-button sre-mode-toggle pilot-mode-toggle" aria-pressed={settings.enabled} aria-busy={busy} aria-disabled={!!disabled||busy} aria-describedby={hintId} disabled={disabled} title={hint} onClick={()=>{if(!disabled&&!busy)void save({enabled:!settings.enabled})}}><Glyph name="lakePilot" size={16}/>Lake Pilot</button>
 </span><span id={hintId} className="visually-hidden" role="status">{hint}</span>
 {settings.enabled&&<PilotAutoAdvance key={project} enabled={settings.autoAdvance} disabled={autoAdvanceDisabled} busy={busy} error={error} onCommit={autoAdvance=>save({autoAdvance})}/>}
 {error&&!settings.enabled&&<span role="alert" className="sre-toggle-error">{error}</span>}</>;
}
