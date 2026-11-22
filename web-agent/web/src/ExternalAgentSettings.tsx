import {useEffect,useRef,useState} from 'react';
import type {ExternalAgentStatus} from '../../shared/external-agents';
import {api,readableError} from './api';
import {Glyph} from './Icons';
import {ProviderIcon} from './ProviderIcon';
import {AppSelect} from './AppSelect';
import {reasoningLabels} from './reasoningLabels';
import './externalAgents.css';

type Draft=ExternalAgentStatus & {npmPath:string;dirty:boolean};
function modelEfforts(agent:ExternalAgentStatus,model=agent.modelOverride??agent.localModel??agent.model){
  const options=agent.modelEffortOptions;
  if(!options)return agent.reasoningEffortOptions??[];
  return model&&Object.hasOwn(options,model)?options[model]:[];
}

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
      const draft=current.find(row=>row.id===agent.id&&row.projectId===agent.projectId);
      if(draft?.dirty&&draft.revision===agent.revision)return {...agent,npmPath:draft.npmPath,nodePath:draft.nodePath,
        modelOverride:draft.modelOverride,reasoningEffortOverride:draft.reasoningEffortOverride,dirty:true};
      return {...agent,npmPath:agent.npmPath??'',dirty:false};
    }));
  }
  useEffect(()=>{const cancel=new AbortController();setLoading(true);setError('');
    void load(cancel.signal).catch(cause=>{if(!cancel.signal.aborted)setError(readableError(cause));}).finally(()=>{if(!cancel.signal.aborted)setLoading(false);});
    return()=>cancel.abort();},[projectId]);
  const update=(id:string,patch:Partial<Draft>)=>setAgents(rows=>rows.map(row=>row.id===id?{...row,...patch,dirty:true}:row));
  const selectModel=(agent:Draft,value:string)=>{
    const modelOverride=value||undefined,effort=agent.reasoningEffortOverride;
    const options=modelEfforts(agent,modelOverride??agent.localModel??agent.model);
    update(agent.id,{modelOverride,reasoningEffortOverride:effort&&options.length&&!options.includes(effort)?undefined:effort});
  };
  async function run(key:string,work:()=>Promise<unknown>,success:string){
    if(flight.current)return;flight.current=true;setBusy(key);setError('');setMessage('');
    try{await work();await load();if(mounted.current)setMessage(success);}
    catch(cause){try{await load();}catch{}if(mounted.current)setError(readableError(cause));}
    finally{flight.current=false;if(mounted.current)setBusy('');}
  }
  const save=(agent:Draft)=>api.prepareExternalAgent(projectId!,{
    enabled:agent.enabled,expectedRevision:agent.revision,nodePath:agent.nodePath??'',npmPath:agent.npmPath,
    modelOverride:agent.modelOverride??null,reasoningEffortOverride:agent.reasoningEffortOverride??null,
  });
  const refresh=async()=>{
    const connected=agents.find(agent=>agent.projectId===projectId&&agent.enabled&&agent.installed);
    if(connected)await api.probeExternalAgent(connected.projectId,connected.id);
  };
  return <section id="agents-settings-panel" role="tabpanel" aria-labelledby="agents-settings-tab" className="model-conversation external-agent-settings">
    {!projectId?<p className="settings-note">请先选择项目，再配置外部 Agent。</p>:<>
      <div className="external-agent-heading"><strong>{projectName||'当前项目'}</strong><span>Codex 连接</span><button className="button secondary" disabled={!!busy} onClick={()=>void run('refresh',refresh,'配置已刷新')}>刷新</button></div>
      <p className="settings-note">专员的任务和协作回复统一使用此项目的 Codex 连接。修改连接配置会停止当前 Codex 调用。</p>
      {loading&&<p role="status">正在读取配置…</p>}
      {agents.map(agent=><article className="external-agent-panel" key={agent.id}>
        <header><span className="external-agent-mark"><ProviderIcon brand="openai" size={23}/></span><div><h3>Codex</h3><small>{agent.assignmentReady?'已就绪':agent.transportReady?(agent.enabled&&agent.assignmentBlocker||'Codex 连接已验证'):agent.installed?'Codex 引擎可用':'启用后自动准备'}</small></div>
          <button className={`provider-switch ${agent.enabled?'on':''}`} type="button" role="switch" aria-label="启用 Codex" aria-checked={agent.enabled} disabled={!!busy} onClick={()=>void run(agent.id,()=>agent.enabled?api.saveExternalAgent(projectId,agent.id,{enabled:false,expectedRevision:agent.revision}):save({...agent,enabled:true}),'Codex 配置已更新')}><span/></button>
        </header>
        <p className="settings-note">复用本机 Codex 的登录与服务。手动选择适用于当前项目的后续专员任务。</p>
        <fieldset className="external-agent-fields" disabled={!!busy}>
          <div className="external-agent-local-config">
            <span className="field-label">当前连接</span>
            <p>{[agent.authMode==='chatgpt'?'ChatGPT 登录':agent.authMode==='api_key'?'Codex API 登录':agent.authMode==='provider'?'本机服务配置':'登录状态待确认',
              agent.model,agent.reasoningEffort].filter(Boolean).join(' · ')}</p>
            <small>{agent.configPath||'自动读取本机 Codex 配置'}</small>
          </div>
          <label className="field-label">模型
            <AppSelect label="Codex 模型" value={agent.modelOverride??''} onChange={event=>selectModel(agent,event.target.value)}>
              <option value="">跟随本机 Codex</option>
              {agent.modelOptions?.map(model=><option key={model} value={model}>{model}</option>)}
              {agent.modelOverride&&!agent.modelOptions?.includes(agent.modelOverride)&&<option value={agent.modelOverride}>{agent.modelOverride}</option>}
            </AppSelect>
          </label>
          <label className="field-label">思考强度
            <AppSelect label="Codex 思考强度" value={agent.reasoningEffortOverride??''} onChange={event=>update(agent.id,{reasoningEffortOverride:event.target.value||undefined})}>
              <option value="">跟随本机 Codex</option>
              {modelEfforts(agent).map(effort=><option key={effort} value={effort}>{reasoningLabels[effort]??effort}</option>)}
              {agent.reasoningEffortOverride&&!modelEfforts(agent).includes(agent.reasoningEffortOverride)&&
                <option value={agent.reasoningEffortOverride}>{reasoningLabels[agent.reasoningEffortOverride]??agent.reasoningEffortOverride}</option>}
            </AppSelect>
          </label>
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
