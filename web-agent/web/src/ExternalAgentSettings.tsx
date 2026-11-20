import {useEffect,useRef,useState} from 'react';
import type {ExternalAgentStatus} from '../../shared/external-agents';
import {api,readableError} from './api';
import {Glyph} from './Icons';
import {ProviderIcon} from './ProviderIcon';
import './externalAgents.css';

type Draft=ExternalAgentStatus & {npmPath:string;dirty:boolean};
export function ExternalAgentSettings({projectId,projectName,onBusyChange}:{projectId?:string;projectName?:string;onBusyChange:(value:boolean)=>void}){
  const [agents,setAgents]=useState<Draft[]>([]);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState('');
  const mounted=useRef(true),flight=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{onBusyChange(!!busy);return()=>onBusyChange(false);},[busy,onBusyChange]);
  async function load(signal?:AbortSignal){
    if(!projectId)return;
    const catalog=await api.externalAgents(projectId,signal);
    if(signal?.aborted||!mounted.current)return;
    setAgents(current=>catalog.agents.map(agent=>{
      const draft=current.find(row=>row.id===agent.id);
      return draft?.dirty&&draft.revision===agent.revision?draft:{...agent,npmPath:agent.npmPath??'',dirty:false};
    }));
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
  const save=(agent:Draft)=>api.prepareExternalAgent(projectId!,{enabled:agent.enabled,expectedRevision:agent.revision,nodePath:agent.nodePath??'',npmPath:agent.npmPath});
  return <section id="agents-settings-panel" role="tabpanel" aria-labelledby="agents-settings-tab" className="model-conversation external-agent-settings">
    {!projectId?<p className="settings-note">请先选择项目，再配置外部 Agent。</p>:<>
      <div className="external-agent-heading"><strong>{projectName||'当前项目'}</strong><span>Codex 连接</span><button className="button secondary" disabled={!!busy} onClick={()=>void run('refresh',()=>load(),'配置已刷新')}>刷新</button></div>
      <p className="settings-note">专员的任务和协作回复统一使用此项目的 Codex 连接。修改连接配置会停止当前 Codex 调用。</p>
      {loading&&<p role="status">正在读取配置…</p>}
      {agents.map(agent=><article className="external-agent-panel" key={agent.id}>
        <header><span className="external-agent-mark"><ProviderIcon brand="openai" size={23}/></span><div><h3>Codex</h3><small>{agent.assignmentReady?'已就绪':agent.transportReady?(agent.enabled&&agent.assignmentBlocker||'Codex 连接已验证'):agent.installed?'Codex 引擎可用':'启用后自动准备'}</small></div>
          <button className={`provider-switch ${agent.enabled?'on':''}`} type="button" role="switch" aria-label="启用 Codex" aria-checked={agent.enabled} disabled={!!busy} onClick={()=>void run(agent.id,()=>agent.enabled?api.saveExternalAgent(projectId,agent.id,{enabled:false,expectedRevision:agent.revision}):save({...agent,enabled:true}),'Codex 配置已更新')}><span/></button>
        </header>
        <p className="settings-note">自动识别本机运行路径，复用 Codex 已有登录与配置。模型、服务地址和思考强度跟随本机 Codex。</p>
        <fieldset className="external-agent-fields" disabled={!!busy}>
          <div className="external-agent-local-config"><span className="field-label">本机 Codex</span><p>{agent.authMode==='chatgpt'?'ChatGPT 登录':agent.authMode==='api_key'?'Codex API 登录':agent.authMode==='provider'?'本机服务配置':'登录状态待确认'} · {agent.model||'本机默认模型'}{agent.reasoningEffort?` · ${agent.reasoningEffort}`:''}</p><small>{agent.configPath||'自动读取本机 Codex 配置'}</small>{agent.defaultTaskModel&&agent.defaultTaskModel!==agent.model&&<small>Lake 新任务默认使用 {agent.defaultTaskModel}</small>}</div>
          <div className="external-agent-path-status"><Glyph name={agent.nodePath&&agent.npmPath?'check':'code'} size={16}/><span>{agent.nodePath&&agent.npmPath?'运行路径已自动识别':'启用后自动识别运行路径'}</span></div>
        </fieldset>
        <details className="external-agent-advanced"><summary>高级设置</summary><fieldset className="external-agent-fields" disabled={!!busy}>
          <label className="field-label">Node 路径<input spellCheck={false} autoComplete="off" placeholder="自动识别，无需填写" value={agent.nodePath??''} onChange={event=>update(agent.id,{nodePath:event.target.value})}/></label>
          <label className="field-label">npm 路径<input spellCheck={false} autoComplete="off" placeholder="自动识别，无需填写" value={agent.npmPath} onChange={event=>update(agent.id,{npmPath:event.target.value})}/></label>
        </fieldset><button type="button" className="provider-text-button" disabled={!!busy} onClick={()=>void run(agent.id,()=>api.prepareExternalAgent(projectId,{expectedRevision:agent.revision,enabled:agent.enabled,nodePath:'',npmPath:'',autoDetect:true}),'运行路径已重新识别')}>重新识别路径</button></details>
        <footer><button className="button" disabled={!!busy||!agent.dirty} onClick={()=>void run(agent.id,()=>save(agent),'Codex 配置已保存')}>{busy===agent.id?'正在准备…':agent.enabled?'保存并连接':'保存'}</button>
          <button className="button secondary" disabled={!!busy||agent.dirty||!agent.installed} onClick={()=>void run(agent.id,()=>api.probeExternalAgent(projectId,agent.id),'Codex 连接验证通过')}>重新连接</button>
        </footer>{agent.message&&<p className="settings-note">{agent.message}</p>}
      </article>)}
      {error&&<p className="form-error" role="alert">{error}</p>}<p className="settings-note" role="status">{busy?'正在处理…':message}</p>
    </>}
  </section>;
}
