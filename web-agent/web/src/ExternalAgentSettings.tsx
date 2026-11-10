import {useEffect,useRef,useState} from 'react';
import type {SpecialistChannelInfo} from '../../shared/contracts';
import type {AgentBackendRef,ExternalAgentStatus} from '../../shared/external-agents';
import {api,readableError} from './api';
import {AppSelect} from './AppSelect';
import {Glyph} from './Icons';
import {ProviderIcon} from './ProviderIcon';
import './externalAgents.css';

type Draft=ExternalAgentStatus & {apiKey:string;clearKey:boolean;npmPath:string;dirty:boolean};
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
      return draft?.dirty&&draft.revision===agent.revision?draft:{...agent,apiKey:'',clearKey:false,npmPath:agent.npmPath??'',dirty:false};
    }));setRoles(workspace.channels??[]);
  }
  useEffect(()=>{const cancel=new AbortController();setLoading(true);setError('');
    void load(cancel.signal).catch(cause=>{if(!cancel.signal.aborted)setError(readableError(cause));}).finally(()=>{if(!cancel.signal.aborted)setLoading(false);});
    return()=>cancel.abort();},[projectId]);
  const update=(id:string,patch:Partial<Draft>)=>setAgents(rows=>rows.map(row=>row.id===id?{...row,...patch,dirty:true}:row));
  async function run(key:string,work:()=>Promise<unknown>,success:string){
    if(flight.current)return;flight.current=true;setBusy(key);setError('');setMessage('');
    try{await work();await load();if(mounted.current)setMessage(success);}
    catch(cause){try{await load();}catch{}if(mounted.current)setError(readableError(cause));}
    finally{flight.current=false;if(mounted.current)setBusy('');}
  }
  const save=(agent:Draft)=>api.prepareExternalAgent(projectId!,{enabled:agent.enabled,expectedRevision:agent.revision,nodePath:agent.nodePath??'',model:agent.model,
    npmPath:agent.npmPath,...(agent.clearKey?{apiKey:''}:agent.apiKey?{apiKey:agent.apiKey}:{})});
  return <section id="agents-settings-panel" role="tabpanel" aria-labelledby="agents-settings-tab" className="model-conversation external-agent-settings">
    {!projectId?<p className="settings-note">请先选择项目，再配置外部 Agent。</p>:<>
      <div className="external-agent-heading"><strong>{projectName||'当前项目'}</strong><span>Codex 连接</span><button className="button secondary" disabled={!!busy} onClick={()=>void run('refresh',()=>load(),'配置已刷新')}>刷新</button></div>
      <p className="settings-note">外部 Agent 沿用当前任务的审批、资源范围和实际回执。修改连接配置会停止该 Agent 的现有调用，原任务记录保留。执行过程与报告在任务详情中查看。</p>
      {loading&&<p role="status">正在读取配置…</p>}
      {agents.map(agent=><article className="external-agent-panel" key={agent.id}>
        <header><span className="external-agent-mark"><ProviderIcon brand="openai" size={23}/></span><div><h3>Codex</h3><small>{agent.assignmentReady?'已就绪':agent.transportReady?(agent.enabled&&agent.assignmentBlocker||'ACP 连接已验证'):agent.installed?'适配器可用':'启用后自动准备'}</small></div>
          <button className={`provider-switch ${agent.enabled?'on':''}`} type="button" role="switch" aria-label="启用 Codex" aria-checked={agent.enabled} disabled={!!busy} onClick={()=>void run(agent.id,()=>agent.enabled?api.saveExternalAgent(projectId,agent.id,{enabled:false,expectedRevision:agent.revision}):save({...agent,enabled:true}),'Codex 配置已更新')}><span/></button>
        </header>
        <p className="settings-note">启用时自动识别本机 Node/npm 并准备 Codex 连接。独立凭据仅用于当前项目；模型为 {agent.model||'gpt-6.1-sol'}。</p>
        <fieldset className="external-agent-fields" disabled={!!busy}>
          <div className="external-agent-key"><label className="field-label">独立 API Key<input type="password" autoComplete="new-password" value={agent.apiKey} placeholder={agent.clearKey?'保存后清除凭据':'留空保留已保存凭据'} onChange={event=>update(agent.id,{apiKey:event.target.value,clearKey:false})}/></label>
          <button type="button" className="provider-text-button" onClick={()=>update(agent.id,{clearKey:!agent.clearKey,apiKey:''})}>{agent.clearKey?'撤销清除':'清除已保存凭据'}</button></div>
          <div className="external-agent-path-status"><Glyph name={agent.nodePath&&agent.npmPath?'check':'code'} size={16}/><span>{agent.nodePath&&agent.npmPath?'运行路径已自动识别':'启用后自动识别运行路径'}</span></div>
        </fieldset>
        <details className="external-agent-advanced"><summary>高级设置</summary><fieldset className="external-agent-fields" disabled={!!busy}>
          <label className="field-label">Node 路径<input spellCheck={false} autoComplete="off" placeholder="自动识别，无需填写" value={agent.nodePath??''} onChange={event=>update(agent.id,{nodePath:event.target.value})}/></label>
          <label className="field-label">npm 路径<input spellCheck={false} autoComplete="off" placeholder="自动识别，无需填写" value={agent.npmPath} onChange={event=>update(agent.id,{npmPath:event.target.value})}/></label>
        </fieldset><button type="button" className="provider-text-button" disabled={!!busy} onClick={()=>void run(agent.id,()=>api.prepareExternalAgent(projectId,{expectedRevision:agent.revision,enabled:agent.enabled,nodePath:'',npmPath:'',autoDetect:true}),'运行路径已重新识别')}>重新识别路径</button></details>
        <footer><button className="button" disabled={!!busy||!agent.dirty} onClick={()=>void run(agent.id,()=>save(agent),'Codex 配置已保存')}>{busy===agent.id?'正在准备…':agent.enabled?'保存并连接':'保存'}</button>
          <button className="button secondary" disabled={!!busy||agent.dirty||!agent.installed} onClick={()=>void run(agent.id,()=>api.probeExternalAgent(projectId,agent.id),'ACP 连接验证通过')}>测试连接</button>
        </footer>{agent.message&&<p className="settings-note">{agent.message}</p>}
      </article>)}
      {roles.length>0&&<div className="external-agent-panel"><h3>专员的新任务默认后端</h3><p className="settings-note">专员默认使用 Codex，也可在聊天框的模型菜单中选择普通模型。已有任务保留原执行者。</p>
        {roles.map(role=><div key={role.roleId} className="external-role-row"><span>{role.roleName}</span><AppSelect label={`${role.roleName} 的任务后端`} disabled={!!busy||role.roleRevision===undefined} value={role.execution?.kind==='acp'?role.execution.agent:'native'} onChange={event=>{
          const value=event.target.value,execution:AgentBackendRef=value==='native'?{kind:'native'}:{kind:'acp',agent:value as 'codex'};
          void run(role.roleId,()=>api.setRoleExecution(projectId,role.roleId,role.roleRevision!,execution),'新任务默认后端已保存');
        }}><option value="codex">Codex</option><option value="native">Lake 原生</option></AppSelect></div>)}
      </div>}
      {error&&<p className="form-error" role="alert">{error}</p>}<p className="settings-note" role="status">{busy?'正在处理…':message}</p>
    </>}
  </section>;
}
