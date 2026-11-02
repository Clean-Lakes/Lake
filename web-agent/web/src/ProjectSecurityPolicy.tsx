import {useEffect,useState} from 'react';
import type {Resource} from '../../shared/contracts';
import {api,readableError} from './api';
import {Glyph} from './Icons';

type PolicyRule={Capability:string;Effect:'allow'|'ask'|'deny';Confirmation?:string;Grantable?:boolean;ResourceIDs?:string[];Limits?:Record<string,unknown>};
export type ProjectPolicy={SchemaVersion:number;Mode:string;Revision:number;ResourceIDs:string[];DenyLocal:boolean;Rules:PolicyRule[]};

export function ProjectSecurityPolicy({projectId,resources}:{projectId:string;resources:Resource[]}){
 const [open,setOpen]=useState(false),[loaded,setLoaded]=useState(false),[policy,setPolicy]=useState<ProjectPolicy|null>(null),[capabilities,setCapabilities]=useState<string[]>([]),[selected,setSelected]=useState<string[]>([]),[denyLocal,setDenyLocal]=useState(true),[memory,setMemory]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  setLoaded(false);setPolicy(null);setError('');const controller=new AbortController();
  void Promise.all([api.projectSecurityPolicy(projectId,controller.signal),api.projectSecurityCapabilities(projectId,controller.signal)]).then(([result,catalog])=>{
   if(controller.signal.aborted)return;const next=result.policy??null;setPolicy(next);setSelected(next?.ResourceIDs??[]);setDenyLocal(next?.DenyLocal??true);setCapabilities(catalog.capabilities);setLoaded(true);
  }).catch(reason=>{if(!controller.signal.aborted)setError(readableError(reason));});return()=>controller.abort();
 },[projectId]);
 const save=async()=>{
  setBusy(true);setError('');
  try{
   const rules=policy?.Rules??capabilities.map(Capability=>({Capability,Effect:memory&&Capability.startsWith('memory.')?'allow' as const:'ask' as const,Confirmation:'single',Grantable:false}));
   const next=await api.saveProjectSecurityPolicy(projectId,{actionId:crypto.randomUUID(),expectedRevision:policy?.Revision??0,policy:{schemaVersion:1,mode:policy?.Mode??'compatible',resourceIDs:selected,denyLocal,rules}});
   setPolicy(next);setSelected(next.ResourceIDs??[]);setDenyLocal(next.DenyLocal);setOpen(false);
  }catch(reason){setError(readableError(reason));}finally{setBusy(false);}
 };
 return <div className="pilot-project-security">
  <button type="button" className="nav-row" onClick={()=>setOpen(value=>!value)} aria-expanded={open}><Glyph name="lakePermission" size={15}/><span className="nav-row-text">{loaded&&!policy?'设置执行范围':'项目执行范围'}</span><Glyph name="chevron" size={13}/></button>
  {open&&<section className="pilot-policy-panel" aria-label="项目执行范围">
   <p>{policy?'资源范围按本次选择更新，现有操作规则保持原设置。':'选择专员可申请访问的资源。每次资源操作单独确认，任务计划仍需确认。'}</p>
   <fieldset disabled={!loaded||busy}><legend>允许申请的资源</legend>{resources.map(resource=><label key={resource.id}><input type="checkbox" checked={selected.includes(resource.id)} onChange={event=>setSelected(current=>event.target.checked?[...current,resource.id]:current.filter(id=>id!==resource.id))}/><span>{resource.name}</span></label>)}{!resources.length&&<p>添加资源后可在这里选择。</p>}
    <label><input type="checkbox" checked={denyLocal} onChange={event=>setDenyLocal(event.target.checked)}/><span>禁止执行本机命令</span></label>
    {!policy&&<label><input type="checkbox" checked={memory} onChange={event=>setMemory(event.target.checked)}/><span>允许 Memory 按已确认的积累与使用设置工作</span></label>}
   </fieldset>
   <details><summary>查看操作规则</summary><pre>{JSON.stringify(policy?.Rules??capabilities.map(Capability=>({Capability,Effect:memory&&Capability.startsWith('memory.')?'allow':'ask',Confirmation:'single'})),null,2)}</pre></details>
   <div className="pilot-policy-actions"><button className="button secondary" type="button" onClick={()=>setOpen(false)} disabled={busy}>取消</button><button className="button" type="button" onClick={()=>void save()} disabled={!loaded||busy}>{busy?'保存中…':policy?'保存范围':'确认并启用'}</button></div>
  </section>}
  {error&&<p className="pilot-workspace-error" role="alert">{error}</p>}
 </div>;
}
