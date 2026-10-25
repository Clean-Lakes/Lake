import {useEffect,useId,useRef,useState} from 'react';
import type {PilotSettings,SessionSnapshot} from '../../shared/contracts';
import {api,readableError} from './api';
import {Glyph} from './Icons';
import {SREModeToggle} from './SREModeToggle';

type PilotMode='off'|'manual'|'auto';
const modeFor=(settings:PilotSettings):PilotMode=>!settings.enabled?'off':settings.autoAdvance?'auto':'manual';
const nextMode=(mode:PilotMode):PilotMode=>mode==='off'?'manual':mode==='manual'?'auto':'off';
const modeLabel={off:'已关闭',manual:'手动选择',auto:'自动推进'};
const nextLabel={off:'开启 Lake Pilot，手动选择方向和命令',manual:'开启自动推进',auto:'关闭 Lake Pilot'};

export function LakePilotControl({snapshot,onUpdated,disabled,disabledReason}:{snapshot:SessionSnapshot;onUpdated:()=>Promise<unknown>;disabled?:boolean;disabledReason?:string}){
 const project=snapshot.session.projectId,incoming=snapshot.sre?.pilot;
 const hintId=useId(),saving=useRef(false),current=useRef(project),desired=useRef<PilotMode|null>(null),blocked=useRef(!!disabled);
 blocked.current=!!disabled;
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const [saved,setSaved]=useState<{project:string;settings:PilotSettings}|null>(null);
 const settings=saved?.project===project&&(!incoming||saved.settings.revision>incoming.revision)?saved.settings:incoming;
 const latest=useRef(settings);latest.current=settings;
 current.current=project;
 useEffect(()=>{current.current=project;return()=>{current.current='';desired.current=null}},[project]);
 if(snapshot.ai?.profile&&snapshot.ai.profile!=='core')return null;
 if(!settings)return <SREModeToggle snapshot={snapshot} onUpdated={onUpdated} disabled={disabled} disabledReason={disabledReason}/>;
 const mode=modeFor(settings);
 const hint=disabled?(disabledReason||'本轮运行中，结束后可切换 Lake Pilot。'):`当前${modeLabel[mode]}；再次点击${nextLabel[mode]}。对新任务生效，变更仍按权限确认。`;
 const cycle=()=>{
  if(disabled)return;
  desired.current=nextMode(desired.current??modeFor(latest.current!));
  if(saving.current)return;
  saving.current=true;setBusy(true);setError('');
  void (async()=>{
   try{
    // Use confirmed revisions, retaining clicks received during save/refresh.
    while(current.current===project&&!blocked.current&&desired.current&&latest.current){
     const target=desired.current,base=latest.current;
     if(target===modeFor(base)){
      await onUpdated();
      if(current.current!==project||desired.current===modeFor(latest.current!))break;
      continue;
     }
     const value=await api.setPilotSettings(project,{enabled:target!=='off',autoAdvance:target==='auto',expectedRevision:base.revision});
     if(current.current!==project)return;
     latest.current=value;setSaved({project,settings:value});
    }
   }catch(e){if(current.current===project){setError(readableError(e));void onUpdated().catch(()=>{})}}
   finally{saving.current=false;desired.current=null;if(current.current===project)setBusy(false)}
  })();
 };
 return <><span className="pilot-control">
  <button type="button" className="composer-permission-button sre-mode-toggle pilot-mode-toggle" data-mode={mode} aria-label={`Lake Pilot：${modeLabel[mode]}；点击${nextLabel[mode]}`} aria-pressed={settings.enabled} aria-busy={busy} aria-disabled={!!disabled} aria-describedby={hintId} disabled={disabled} title={hint} onClick={cycle}><Glyph name="lakePilot" size={16}/>Lake Pilot{mode==='auto'&&<span className="pilot-auto-badge" aria-hidden="true">AUTO</span>}</button>
 </span><span id={hintId} className="visually-hidden" role="status">{busy?'正在保存 Lake Pilot 设置…':hint}</span>
 {error&&<span role="alert" className="sre-toggle-error">{error}</span>}</>;
}
