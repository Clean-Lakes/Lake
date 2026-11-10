import {useEffect,useRef,useState} from 'react';
import type {SpecialistChannelInfo} from '../../shared/contracts';
import type {AgentBackendRef,ExternalAgentStatus} from '../../shared/external-agents';
import {api,readableError} from './api';
import {AppSelect} from './AppSelect';
import {Glyph} from './Icons';
import {ProviderIcon} from './ProviderIcon';
import './externalAgents.css';

type Draft=ExternalAgentStatus & {apiKey:string;clearKey:boolean;npmPath:string;dirty:boolean};
const backendRevision=(backend?:AgentBackendRef)=>backend?.kind==='acp'?backend.revision:undefined;
export function ExternalAgentSettings({projectId,projectName,onBusyChange}:{projectId?:string;projectName?:string;onBusyChange:(value:boolean)=>void}){
  const [agents,setAgents]=useState<Draft[]>([]),[roles,setRoles]=useState<SpecialistChannelInfo[]>([]);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState('');
  const mounted=useRef(true),flight=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{onBusyChange(!!busy);return()=>onBusyChange(false);},[busy,onBusyChange]);
  async function load(signal?:AbortSignal){
    if(!projectId)return;
    const [catalog,workspace]=await Promise.all([api.externalAgents(projectId,signal),api.superWorkspace(projectId,signal)]);
    if(signal?.aborted||!mounted.current)return;
    setAgents(current=>catalog.agents.map(agent=>{
      const draft=current.find(row=>row.id===agent.id);
      return draft?.dirty&&draft.revision===agent.revision?draft:{...agent,apiKey:'',clearKey:false,npmPath:draft?.npmPath??'',dirty:false};
    }));setRoles(workspace.channels??[]);
  }
  useEffect(()=>{const cancel=new AbortController();setLoading(true);setError('');
    void load(cancel.signal).catch(cause=>{if(!cancel.signal.aborted)setError(readableError(cause));}).finally(()=>{if(!cancel.signal.aborted)setLoading(false);});
    return()=>cancel.abort();},[projectId]);
  const update=(id:string,patch:Partial<Draft>)=>setAgents(rows=>rows.map(row=>row.id===id?{...row,...patch,dirty:true}:row));
  async function run(key:string,work:()=>Promise<unknown>,success:string){
    if(flight.current)return;flight.current=true;setBusy(key);setError('');setMessage('');
    try{await work();await load();if(mounted.current)setMessage(success);}
    catch(cause){if(mounted.current)setError(readableError(cause));}
    finally{flight.current=false;if(mounted.current)setBusy('');}
  }
  const save=(agent:Draft)=>api.saveExternalAgent(projectId!,agent.id,{enabled:agent.enabled,expectedRevision:agent.revision,nodePath:agent.nodePath??'',model:agent.model,
    ...(agent.clearKey?{apiKey:''}:agent.apiKey?{apiKey:agent.apiKey}:{})});
  return <section id="agents-settings-panel" role="tabpanel" aria-labelledby="agents-settings-tab" className="model-conversation external-agent-settings">
    {!projectId?<p className="settings-note">请先选择项目，再配置外部 Agent。</p>:<>
      <div className="external-agent-heading"><strong>{projectName||'当前项目'}</strong><span>ACP 执行后端</span><button className="button secondary" disabled={!!busy} onClick={()=>void run('refresh',()=>load(),'配置已刷新')}>刷新</button></div>
      <p className="settings-note">外部 Agent 沿用当前任务的审批、资源范围和实际回执。修改连接配置会停止该 Agent 的现有调用，原任务记录保留。执行过程与报告在任务详情中查看。</p>
      {loading&&<p role="status">正在读取配置…</p>}
      {agents.map(agent=><article className="external-agent-panel" key={agent.id}>
        <header><span className="external-agent-mark">{agent.id==='codex'?<ProviderIcon name="OpenAI" size={23}/>:<Glyph name="code" size={23}/>}</span><div><h3>{agent.name}</h3><small>{agent.transportReady?'ACP 连接已验证':agent.installed?'适配器可用':'需要安装适配器'}</small></div>
          <button className={`provider-switch ${agent.enabled?'on':''}`} type="button" role="switch" aria-label={`启用 ${agent.name}`} aria-checked={agent.enabled} disabled={!!busy} onClick={()=>update(agent.id,{enabled:!agent.enabled})}><span/></button>
        </header>
        <p className="settings-note">{agent.id==='runtime-acp'?'独立进程运行当前固定版本的 Agent SDK，由 ACP 适配器连接；使用 Lake 当前模型。':'独立运行 Codex ACP 适配器；使用本项目单独保存的 API Key。模型：gpt-6.1-sol。'}</p>
        {agent.id==='codex'&&<fieldset className="external-agent-fields" disabled={!!busy}>
          <label className="field-label">Node 路径<input spellCheck={false} autoComplete="off" placeholder="/absolute/path/to/node" value={agent.nodePath??''} onChange={event=>update(agent.id,{nodePath:event.target.value})}/></label>
          <div className="external-agent-key"><label className="field-label">独立 API Key<input type="password" autoComplete="new-password" value={agent.apiKey} placeholder={agent.clearKey?'保存后清除凭据':'留空保留已保存凭据'} onChange={event=>update(agent.id,{apiKey:event.target.value,clearKey:false})}/></label>
          <button className="provider-text-button" onClick={()=>update(agent.id,{clearKey:!agent.clearKey,apiKey:''})}>{agent.clearKey?'撤销清除':'清除已保存凭据'}</button></div>
          <label className="field-label">npm 路径<input spellCheck={false} autoComplete="off" placeholder="/absolute/path/to/npm" value={agent.npmPath} onChange={event=>setAgents(rows=>rows.map(row=>row.id===agent.id?{...row,npmPath:event.target.value}:row))}/></label>
        </fieldset>}
        <footer><button className="button" disabled={!!busy||!agent.dirty} onClick={()=>void run(agent.id,()=>save(agent),'外部 Agent 配置已保存')}>保存</button>
          <button className="button secondary" disabled={!!busy||agent.dirty||!agent.installed} onClick={()=>void run(agent.id,()=>api.probeExternalAgent(projectId,agent.id),'ACP 连接验证通过')}>测试连接</button>
          {agent.id==='codex'&&<button className="button secondary" disabled={!!busy||agent.dirty||!agent.nodePath||!agent.npmPath} onClick={()=>void run(agent.id,()=>api.installExternalAgent(projectId,agent.id,agent.npmPath),'固定版本适配器已安装')}>{busy===agent.id?'处理中…':agent.installed?'重新安装适配器':'安装适配器'}</button>}
        </footer>{agent.message&&<p className="settings-note">{agent.message}</p>}
      </article>)}
      {roles.length>0&&<div className="external-agent-panel"><h3>专员的新任务默认后端</h3><p className="settings-note">新任务冻结所选配置；已有任务继续使用原后端。修改外部 Agent 配置后，请为后续任务重新选择。</p>
        {roles.map(role=><div key={role.roleId} className="external-role-row"><span>{role.roleName}</span><AppSelect label={`${role.roleName} 的任务后端`} disabled={!!busy||role.roleRevision===undefined} value={role.execution?.kind==='acp'?role.execution.agent:'native'} onChange={event=>{
          const value=event.target.value,execution:AgentBackendRef=value==='native'?{kind:'native'}:{kind:'acp',agent:value as 'codex'|'runtime-acp'};
          void run(role.roleId,()=>api.setRoleExecution(projectId,role.roleId,role.roleRevision!,execution),'新任务默认后端已保存');
        }}><option value="native">Lake 原生</option>{agents.filter(agent=>agent.enabled||role.execution?.kind==='acp'&&role.execution.agent===agent.id).map(agent=><option key={agent.id} value={agent.id}>{agent.name} · ACP</option>)}</AppSelect>{role.execution?.kind==='acp'&&agents.some(agent=>agent.id===(role.execution as {agent:string}).agent&&agent.enabled&&agent.revision!==backendRevision(role.execution))&&<button className="provider-text-button" disabled={!!busy} onClick={()=>void run(role.roleId,()=>api.setRoleExecution(projectId,role.roleId,role.roleRevision!,role.execution!),'已更新新任务使用的连接配置')}>应用新配置</button>}</div>)}
      </div>}
      {error&&<p className="form-error" role="alert">{error}</p>}<p className="settings-note" role="status">{busy?'正在处理…':message}</p>
    </>}
  </section>;
}
