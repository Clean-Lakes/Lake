import {useEffect,useId,useRef,useState} from 'react';
import type {PilotSettings,SessionSnapshot} from '../../shared/contracts';
import {api,readableError} from './api';
import {Glyph} from './Icons';
import {NavigationMenu} from './NavigationDelete';
import {SREModeToggle} from './SREModeToggle';

export function LakePilotControl({snapshot,onUpdated,disabled,disabledReason}:{snapshot:SessionSnapshot;onUpdated:()=>Promise<unknown>;disabled?:boolean;disabledReason?:string}){
 const project=snapshot.session.projectId, incoming=snapshot.sre?.pilot;
 const hintId=useId(),anchor=useRef<HTMLButtonElement>(null),saving=useRef(false),current=useRef(project);
 current.current=project;
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[menu,setMenu]=useState<{x:number;y:number}|null>(null);
 const [saved,setSaved]=useState<{project:string;settings:PilotSettings}|null>(null);
 useEffect(()=>{current.current=project;return()=>{current.current=''}},[project]);
 useEffect(()=>{setMenu(null);setError('')},[project]);
 if(snapshot.ai?.profile&&snapshot.ai.profile!=='core')return null;
 if(!incoming)return <SREModeToggle snapshot={snapshot} onUpdated={onUpdated} disabled={disabled} disabledReason={disabledReason}/>;
 const settings=saved?.project===project&&saved.settings.revision>incoming.revision?saved.settings:incoming;
 const hint=busy?'正在保存 Lake Pilot 设置…':disabled?(disabledReason||'本轮运行中，结束后可切换 Lake Pilot。'):'Lake Pilot · 专员协作与分层操作，对当前项目生效。';
 const save=async(updates:{enabled?:boolean;autoAdvance?:boolean})=>{
  if(saving.current)return;saving.current=true;setBusy(true);setError('');
  try{const value=await api.setPilotSettings(project,{...updates,expectedRevision:settings.revision});if(current.current===project){setSaved({project,settings:value});await onUpdated()}}
  catch(e){if(current.current===project){setError(readableError(e));void onUpdated().catch(()=>{})}}
  finally{saving.current=false;if(current.current===project)setBusy(false)}
 };
 return <><span className="pilot-control">
  <button type="button" className="composer-permission-button sre-mode-toggle pilot-mode-toggle" aria-pressed={settings.enabled} aria-busy={busy} aria-disabled={!!disabled||busy} aria-describedby={hintId} disabled={disabled} title={hint} onClick={()=>{if(!disabled&&!busy)void save({enabled:!settings.enabled})}}>Lake Pilot</button>
  <button ref={anchor} type="button" className="composer-permission-button pilot-settings-trigger" aria-label="Lake Pilot 设置" aria-haspopup="menu" aria-expanded={!!menu} aria-disabled={busy} title="Lake Pilot 设置" onClick={()=>{if(busy)return;const rect=anchor.current?.getBoundingClientRect();if(rect)setMenu(value=>value?null:{x:rect.left,y:rect.top-132})}}><Glyph name="chevron" size={12}/></button>
 </span><span id={hintId} className="visually-hidden" role="status">{hint}</span>
 {menu&&<NavigationMenu title="Lake Pilot · 当前项目" x={menu.x} y={menu.y} width={320} anchor={anchor} onClose={()=>setMenu(null)} actions={[{label:'自动推进',description:settings.enabled?'由 Lake 选择方向和命令；对新任务生效，变更仍按权限确认。':'开启 Lake Pilot 后生效；对新任务生效。',checked:settings.autoAdvance,selectionType:'checkbox',disabled:!settings.enabled||busy,run:()=>void save({autoAdvance:!settings.autoAdvance})}]}/>}
 {error&&<span role="alert" className="sre-toggle-error">{error}</span>}</>;
}
