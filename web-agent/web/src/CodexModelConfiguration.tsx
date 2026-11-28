import {useEffect,useId,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import type {SpecialistChannelInfo} from '../../shared/contracts';
import {cliDefaultAuthentication,externalAgentName,isExternalAgentId,type AntigravityGoogleAuthorization,type ClaudeGateway,type CliAuthentication,
  type ExternalAgentId,type ExternalAgentStatus} from '../../shared/external-agents';
import {api,ApiRequestError,readableError} from './api';
import {AppSelect} from './AppSelect';
import {ExecutionAgentIcon} from './ExecutionAgentIcon';
import {Glyph} from './Icons';
import {ProviderIcon} from './ProviderIcon';
import {modelBrand} from './modelBrand';
import {reasoningLabels} from './reasoningLabels';
import {TabSelectionIndicator} from './TabSelectionIndicator';
import {navigateSettingsTabs} from './settingsFocus';
import './codexModelConfiguration.css';

type Preferences = {
  model:string;effort:string;enabled:boolean;nodePath:string;npmPath:string;executablePath:string;authentication?:CliAuthentication;
  gatewayBaseURL:string;gatewayCredentialHeader:ClaudeGateway['credentialHeader'];
};
const executors:ExternalAgentId[]=['codex','claude-code','antigravity'];
const installGuides={'claude-code':'https://code.claude.com/docs/en/quickstart',antigravity:'https://antigravity.google/docs/ide/extensions/acp/'};
const narrowPanel = '(max-width: 600px)';
const manualModelOption = ':manual';

function preferences(agent:ExternalAgentStatus):Preferences {
  return {model:agent.modelOverride??'',effort:agent.reasoningEffortOverride??'',enabled:agent.enabled,
    nodePath:agent.nodePath??'',npmPath:agent.npmPath??'',executablePath:agent.executablePath??'',
    authentication:agent.id==='codex'?undefined:
      agent.authentication&&agent.authentication!=='codex-local'?agent.authentication:cliDefaultAuthentication[agent.id],
    gatewayBaseURL:agent.claudeGateway?.baseURL??'',gatewayCredentialHeader:agent.claudeGateway?.credentialHeader??'authorization'};
}

function modelEfforts(agent:ExternalAgentStatus,model:string){
  const selected=model||agent.localModel||agent.model;
  if(agent.modelEffortOptions)return selected&&Object.hasOwn(agent.modelEffortOptions,selected)?agent.modelEffortOptions[selected]??[]:[];
  return selected===(agent.modelOverride??agent.localModel??agent.model)?agent.reasoningEffortOptions??[]:[];
}

function Choice({name,value,selected,onChange,icon,children}:{name:string;value:string;selected:boolean;onChange:()=>void;icon?:ReactNode;children:string}){
  return <label className="codex-config-choice">
    <input className="visually-hidden" name={name} type="radio" value={value} checked={selected} onChange={onChange}/>
    {icon&&<span className="codex-config-choice-icon">{icon}</span>}
    <span className="codex-config-choice-label" title={children}>{children}</span>
    {selected&&<Glyph className="codex-config-check" name="check" size={15}/>}
  </label>;
}

function revealSelected(list:HTMLElement){
  const row=list.querySelector('input:checked')?.closest('label');
  if(!row)return;
  const bounds=list.getBoundingClientRect(),selected=row.getBoundingClientRect();
  if(selected.bottom>bounds.bottom)list.scrollTop+=selected.bottom-bounds.bottom;
  else if(selected.top<bounds.top)list.scrollTop+=selected.top-bounds.top;
}

export function CodexModelConfiguration({projectId,projectName,anchor,channel,onClose,onRoleChanged}:{
  projectId:string;projectName:string;anchor?:HTMLElement|null;channel?:SpecialistChannelInfo;onClose:()=>void;onRoleChanged?:()=>void;
}){
  const titleId=useId(),dialog=useRef<HTMLDialogElement>(null),search=useRef<HTMLInputElement>(null);
  const gatewayAddress=useRef<HTMLInputElement>(null);
  const panelId=titleId+'-panel',connectionId=titleId+'-connection';
  const [role,setRole]=useState(channel);
  const binding=role?.execution?.kind==='acp'?role.execution.agent:undefined;
  const roleAgent=isExternalAgentId(binding)?binding:'codex';
  const [executor,setExecutor]=useState<ExternalAgentId>(roleAgent);
  const name=externalAgentName(executor);
  const [compact,setCompact]=useState(()=>window.matchMedia(narrowPanel).matches);
  const [connectionOpen,setConnectionOpen]=useState(false);
  const [editingClaudeModel,setEditingClaudeModel]=useState(false);
  const [agents,setAgents]=useState<ExternalAgentStatus[]>([]);
  const [drafts,setDrafts]=useState<Partial<Record<ExternalAgentId,Preferences>>>({});
  const [keys,setKeys]=useState<Partial<Record<ExternalAgentId,string|null>>>({});
  const [query,setQuery]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
  const [error,setError]=useState(''),[feedback,setFeedback]=useState('');
  const flight=useRef(false),mounted=useRef(false);
  const loginRequest=useRef<AbortController>(null),pendingLogin=useRef<AntigravityGoogleAuthorization>(null);
  const googleLink=useRef<HTMLAnchorElement>(null);
  const [googleLogin,setGoogleLogin]=useState<AntigravityGoogleAuthorization>();
  const [googleCode,setGoogleCode]=useState('');
  const agent=agents.find(agent=>agent.id===executor);
  const initial=agent&&preferences(agent),draft=drafts[executor]??initial;
  const codexSelected=executor==='codex';
  const manualModel=executor==='claude-code';
  const customGateway=draft?.authentication==='claude-custom-api';
  const gatewayChanged=initial?.gatewayBaseURL!==draft?.gatewayBaseURL||initial?.gatewayCredentialHeader!==draft?.gatewayCredentialHeader;
  const authChanged=initial?.authentication!==draft?.authentication;
  const connectionChanged=authChanged||customGateway&&gatewayChanged||initial?.executablePath!==draft?.executablePath;
  const showModels=codexSelected||agent?.transportReady===true&&!connectionChanged;
  const keyMode=draft?.authentication==='cli-api-key'||customGateway;
  const keyConfigured=agent?.keyConfigured&&(customGateway?!authChanged&&!gatewayChanged:initial?.authentication!=='claude-custom-api');
  const editingModel=manualModel&&(editingClaudeModel||!!(draft?.model&&!agent?.modelOptions?.includes(draft.model)));
  const apiKey=keys[executor];
  const googleSelected=draft?.authentication==='antigravity-google';
  const awaitingGoogle=googleSelected&&!!googleLogin;
  const connectionExpanded=!showModels||connectionOpen||awaitingGoogle;

  useLayoutEffect(()=>{
    const node=dialog.current;
    if(!node)return;
    const previous=anchor??document.activeElement as HTMLElement|null;
    node.showModal();
    const place=()=>{
      const bounds=anchor?.isConnected?anchor.getBoundingClientRect():undefined;
      const width=node.offsetWidth,height=node.offsetHeight;
      const narrow=window.matchMedia(narrowPanel).matches;
      setCompact(narrow);
      let x=(window.innerWidth-width)/2;
      if(bounds?.width&&!narrow){
        x=bounds.right+8;
        if(x+width>window.innerWidth-12&&bounds.left-width-8>=12)x=bounds.left-width-8;
      }
      const y=bounds?.height&&!narrow?bounds.top-8:(window.innerHeight-height)/2;
      node.style.left=Math.max(12,Math.min(x,window.innerWidth-width-12))+'px';
      node.style.top=Math.max(12,Math.min(y,window.innerHeight-height-12))+'px';
    };
    place();
    const resize=new ResizeObserver(place);
    resize.observe(node);
    window.addEventListener('resize',place);
    return ()=>{
      resize.disconnect();
      window.removeEventListener('resize',place);
      node.close();
      if(previous?.isConnected)previous.focus({preventScroll:true});
    };
  },[anchor]);

  useEffect(()=>{
    const controller=new AbortController();
    mounted.current=true;
    void api.externalAgents(projectId,controller.signal).then(({agents})=>{
      if(controller.signal.aborted)return;
      setAgents(agents);
      if(!agents.length)setError('未找到此项目的执行器配置');
    }).catch(cause=>{
      if(!controller.signal.aborted)setError(readableError(cause));
    }).finally(()=>{
      if(!controller.signal.aborted)setLoading(false);
    });
    return ()=>{
      mounted.current=false;controller.abort();loginRequest.current?.abort();
      const pending=pendingLogin.current;
      if(pending)void api.cancelAntigravityGoogleLogin(projectId,pending.id).catch(()=>{});
      pendingLogin.current=null;
    };
  },[projectId]);

  useLayoutEffect(()=>{
    if(!loading)search.current?.focus({preventScroll:true});
  },[loading]);
  useLayoutEffect(()=>{
    if(awaitingGoogle)googleLink.current?.focus({preventScroll:true});
  },[awaitingGoogle]);
  useLayoutEffect(()=>{
    if(customGateway&&authChanged)gatewayAddress.current?.focus({preventScroll:true});
  },[customGateway,authChanged]);

  const dirty=apiKey!==undefined||!!(initial&&draft&&Object.keys(initial).some(key=>initial[key as keyof Preferences]!==draft[key as keyof Preferences]));
  const options=agent&&draft?modelEfforts(agent,draft.model):[];
  const observed=agent&&[agent.authMode==='chatgpt'?'ChatGPT 登录':agent.authMode==='api_key'?(codexSelected?'Codex API 登录':'API Key'):
    agent.authMode==='provider'?'本机服务':agent.authMode==='claude_login'?'本机 Claude Code 登录':
    agent.authMode==='google'?'Google 登录':undefined,agent.defaultTaskModel??agent.model,agent.reasoningEffort&&
    (reasoningLabels[agent.reasoningEffort]??agent.reasoningEffort)].filter(Boolean).join(' · ');
  const models=[...new Set([...(agent?.modelOptions??[]),editingModel?undefined:draft?.model].filter((model):model is string=>!!model))];
  const filter=query.trim().toLowerCase();
  const matching=models.filter(model=>model.toLowerCase().includes(filter));
  const followsLocal=codexSelected||draft?.authentication==='claude-local';
  const followModel=followsLocal?`跟随本机 ${name}`:`跟随 ${name} 默认`;
  const cliStatus=showModels?agent?.assignmentBlocker:
    (connectionChanged?undefined:agent?.message)??(agent?.installed
      ?customGateway?undefined:
        draft?.authentication==='cli-api-key'&&!keyConfigured?'配置项目 API Key 并启用后，自动读取可用模型。':
        googleSelected?'完成 Google 授权后自动加载模型。':
        draft?.authentication==='claude-local'?'启用后自动读取本机 Claude Code 的登录和模型。':agent.assignmentBlocker
      :agent?.assignmentBlocker);
  const status=error||feedback||(awaitingGoogle?(busy?'正在处理 Google 授权…':''):
    codexSelected?agent?.assignmentBlocker:cliStatus);
  const update=(value:Partial<Preferences>)=>{setFeedback('');if(draft)setDrafts(current=>({...current,[executor]:{...draft,...value}}));};
  const selectAuthentication=(authentication:CliAuthentication)=>{
    const gatewaySwitch=authentication==='claude-custom-api'||customGateway;
    setKeys(previous=>({...previous,[executor]:undefined}));
    setError('');
    setEditingClaudeModel(false);
    update({authentication,effort:'',...(gatewaySwitch&&{model:''})});
  };
  const requestClose=()=>{if(!flight.current)onClose();};
  const optionsFor=(model:string)=>agent&&draft&&modelEfforts(agent,model).includes(draft.effort)?draft.effort:'';

  useLayoutEffect(()=>{
    dialog.current?.querySelectorAll<HTMLElement>('.codex-config-options').forEach(revealSelected);
  },[agent,showModels,draft?.model,draft?.effort,filter]);

  async function change(operation:()=>Promise<{agents?:ExternalAgentStatus[]}>,success:string){
    if(flight.current)return;
    flight.current=true;
    setBusy(true);setError('');setFeedback('');
    try{
      const response=await operation();
      const current=response.agents??(await api.externalAgents(projectId)).agents;
      const next=current.find(row=>row.id===executor);
      if(!mounted.current)return;
      if(!next)throw new Error(`未找到此项目的 ${name} 配置`);
      setAgents(current);setDrafts(previous=>({...previous,[executor]:undefined}));setKeys(previous=>({...previous,[executor]:undefined}));
      if(!showModels&&next.transportReady)setConnectionOpen(false);
      setFeedback(next.enabled&&!next.assignmentReady?next.assignmentBlocker??success:success);
    }catch(cause){
      if(!mounted.current)return;
      setError(readableError(cause));
      try{
        const current=(await api.externalAgents(projectId)).agents,next=current.find(row=>row.id===executor);
        if(mounted.current&&next){setAgents(current);if(next.revision!==agent?.revision){
          setDrafts(previous=>({...previous,[executor]:undefined}));setKeys(previous=>({...previous,[executor]:undefined}));
        }}
      }catch{/* Keep the first error and the editable preferences. */}
    }finally{
      flight.current=false;
      if(mounted.current)setBusy(false);
    }
  }

  function save(autoDetect=false){
    if(!agent||!draft)return;
    const runtime=codexSelected?{
      nodePath:autoDetect?'':draft.nodePath,npmPath:autoDetect?'':draft.npmPath,
      ...(autoDetect&&{autoDetect}),
    }:{executablePath:draft.executablePath.trim(),authentication:draft.authentication,
      ...(keyMode&&{apiKey:apiKey?.trim()||apiKey}),
      ...(customGateway&&{claudeGateway:{baseURL:draft.gatewayBaseURL.trim(),credentialHeader:draft.gatewayCredentialHeader}})};
    void change(()=>api.prepareExternalAgent(projectId,executor,{
      expectedRevision:agent.revision,enabled:draft.enabled,modelOverride:draft.model.trim()||null,
      reasoningEffortOverride:draft.effort||null,...runtime,
    }),autoDetect?'已重新识别运行路径':'模型配置已保存');
  }

  function reconnect(){
    void change(async()=>{await api.probeExternalAgent(projectId,executor);return {};},`${name} 连接已刷新`);
  }

  function clearGoogleLogin(){
    pendingLogin.current=null;
    setGoogleLogin(undefined);
    setGoogleCode('');
  }

  async function startGoogleLogin(){
    if(!agent||!agent.installed||dirty||flight.current)return;
    const controller=new AbortController();
    loginRequest.current=controller;
    flight.current=true;setBusy(true);setError('');setFeedback('');
    try{
      const authorization=await api.startAntigravityGoogleLogin(projectId,agent.revision,controller.signal);
      if(controller.signal.aborted){void api.cancelAntigravityGoogleLogin(projectId,authorization.id).catch(()=>{});return;}
      pendingLogin.current=authorization;
      setGoogleLogin(authorization);
    }catch(cause){
      if(!controller.signal.aborted)setError(readableError(cause));
    }finally{
      loginRequest.current=null;flight.current=false;
      if(mounted.current)setBusy(false);
    }
  }

  function submitGoogleCode(){
    if(!googleLogin||!googleCode.trim())return;
    void change(async()=>{
      try{
        const result=await api.completeAntigravityGoogleLogin(projectId,googleLogin.id,googleCode.trim());
        if(mounted.current){clearGoogleLogin();setConnectionOpen(false);}
        return result;
      }catch(cause){
        if(mounted.current&&!(cause instanceof ApiRequestError&&cause.status===400)){
          clearGoogleLogin();
          void api.cancelAntigravityGoogleLogin(projectId,googleLogin.id).catch(()=>{});
        }
        throw cause;
      }
    },'Google 登录已就绪，已加载可用模型');
  }

  async function cancelGoogleLogin(){
    if(!googleLogin||flight.current)return;
    flight.current=true;setBusy(true);setError('');setFeedback('');
    try{
      await api.cancelAntigravityGoogleLogin(projectId,googleLogin.id);
      if(mounted.current)clearGoogleLogin();
    }catch(cause){
      if(mounted.current)setError(readableError(cause));
    }finally{
      flight.current=false;
      if(mounted.current)setBusy(false);
    }
  }

  function applyRole(){
    if(!role?.roleRevision||!agent?.assignmentReady||dirty||roleAgent===executor)return;
    const {roleId,roleRevision}=role;
    void change(async()=>{
      const result=await api.setRoleExecution(projectId,roleId,roleRevision,{kind:'acp',agent:executor,revision:agent.revision});
      if(mounted.current)setRole({...role,execution:result.execution,roleRevision:result.revision});
      onRoleChanged?.();
      return {};
    },`已为${role.roleName}启用 ${name}`);
  }

  return <dialog ref={dialog} role="dialog" className="codex-config" aria-labelledby={titleId} data-anchored={anchor?true:undefined}
    onCancel={event=>{event.preventDefault();requestClose();}}
    onClick={event=>{
      if(event.target!==event.currentTarget)return;
      const bounds=event.currentTarget.getBoundingClientRect();
      if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)requestClose();
    }}
    onKeyDown={event=>{
      if(event.key!=='Escape'||event.nativeEvent.isComposing||event.keyCode===229)return;
      event.preventDefault();
      if(event.target===search.current&&query)setQuery('');
      else requestClose();
    }}>
    <header className="codex-config-header">
      <h2 id={titleId}>模型配置</h2>
      <p title={projectName}>{projectName} · 项目共享</p>
      <button type="button" className="icon-button" aria-label="关闭模型配置" disabled={busy} onClick={requestClose}><Glyph name="close" size={17}/></button>
    </header>
    <div className="codex-config-body">
      <div className="codex-config-executors" role="tablist" aria-label="执行器" aria-orientation={compact?'horizontal':'vertical'}
        onKeyDown={event=>navigateSettingsTabs(event,event.currentTarget)}>
        {executors.map(option=><button key={option} type="button" role="tab" id={titleId+'-'+option} title={externalAgentName(option)}
          aria-selected={option===executor} aria-controls={option===executor?panelId:undefined} tabIndex={option===executor?0:-1}
          disabled={busy} onClick={()=>{setExecutor(option);setQuery('');setError('');setFeedback('');setConnectionOpen(false);setEditingClaudeModel(false);}}>
          <ExecutionAgentIcon agent={option} size={16}/><span>{option==='antigravity'?'Antigravity':externalAgentName(option)}</span>
        </button>)}
        <TabSelectionIndicator selection={executor}/>
      </div>
      <div className="codex-config-panel" id={panelId} role="tabpanel" aria-labelledby={titleId+'-'+executor}
        tabIndex={!showModels||!draft?0:undefined}>
        {role&&<div className="codex-config-role">
          <div><strong title={role.roleName}>{role.roleName}</strong><span><ExecutionAgentIcon agent={roleAgent} size={13}/>{externalAgentName(roleAgent)}</span></div>
          {roleAgent===executor?<span className="codex-config-role-current"><Glyph name="check" size={14}/>当前执行器</span>:
            <button type="button" className="button secondary" disabled={busy||dirty||!role.roleRevision||!agent?.assignmentReady} onClick={applyRole}>用于此专员</button>}
        </div>}
        {agent&&draft&&<fieldset className={codexSelected?'codex-config-fields':'codex-config-fields codex-config-cli'} disabled={busy}>
            {showModels&&<div className="codex-config-columns">
              <section className="codex-config-models" aria-label="模型">
                <label className="codex-config-search"><Glyph name="search" size={16}/><input ref={search} type="search"
                  placeholder="搜索模型" aria-label="搜索模型" value={query} onChange={event=>setQuery(event.target.value)}/></label>
                <div className="codex-config-options" role="radiogroup" aria-label={name+' 模型'}>
                  {!filter&&!customGateway&&<Choice name={titleId+'-model'} value="" selected={!draft.model&&!editingModel} icon={<Glyph name="local" size={15}/>}
                    onChange={()=>{setEditingClaudeModel(false);update({model:'',effort:optionsFor('')});}}>{followModel}</Choice>}
                  {matching.map(model=><Choice key={model} name={titleId+'-model'} value={model} selected={!editingModel&&draft.model===model}
                    icon={customGateway?<ProviderIcon brand={modelBrand(model)} size={15}/>:<ExecutionAgentIcon agent={executor} size={15}/>}
                    onChange={()=>{setEditingClaudeModel(false);update({model,effort:optionsFor(model)});}}>{model}</Choice>)}
                  {manualModel&&!filter&&<Choice name={titleId+'-model'} value={manualModelOption} selected={editingModel}
                    icon={<Glyph name="edit" size={15}/>} onChange={()=>setEditingClaudeModel(true)}>手动填写模型</Choice>}
                  {filter&&!matching.length&&<p>没有匹配的模型</p>}
                </div>
                {editingModel&&<label className="codex-config-search"><input autoFocus aria-label="模型 ID"
                  value={draft.model} placeholder="输入模型 ID" spellCheck={false}
                  onChange={event=>update({model:event.target.value,effort:optionsFor(event.target.value.trim())})}/></label>}
              </section>
              <section className="codex-config-reasoning" aria-label="思考强度">
                <h3>思考强度</h3>
                <div className="codex-config-options" role="radiogroup" aria-label={name+' 思考强度'}>
                  <Choice name={titleId+'-effort'} value="" selected={!draft.effort} onChange={()=>update({effort:''})}>
                    {followsLocal?'跟随本机':'跟随默认'}
                  </Choice>
                  {(codexSelected?[...new Set([...options,...(draft.effort?[draft.effort]:[])])]:options).map(effort=><Choice key={effort}
                    name={titleId+'-effort'} value={effort} selected={draft.effort===effort}
                    onChange={()=>update({effort})}>{reasoningLabels[effort]??effort}</Choice>)}
                  {!codexSelected&&!options.length&&<p>此模型由 CLI 决定思考强度。</p>}
                </div>
              </section>
            </div>}
            {codexSelected?<div id={connectionId} className="codex-config-connection-fields" hidden={!connectionExpanded}>
              {observed&&<p>{observed}</p>}
              <label><span>启用 Codex</span><input type="checkbox" checked={draft.enabled} onChange={event=>update({enabled:event.target.checked})}/></label>
              <label><span>Node 路径</span><input value={draft.nodePath} placeholder="自动识别" spellCheck={false} onChange={event=>update({nodePath:event.target.value})}/></label>
              <label><span>npm 路径</span><input value={draft.npmPath} placeholder="自动识别" spellCheck={false} onChange={event=>update({npmPath:event.target.value})}/></label>
              <div className="codex-config-actions">
                <button type="button" className="button secondary" onClick={()=>save(true)}>重新识别路径</button>
                <button type="button" className="button secondary" disabled={dirty||!agent.installed||!agent.enabled} onClick={reconnect}>重新连接</button>
              </div>
            </div>:<div id={connectionId} hidden={!connectionExpanded}>
            <div className="codex-config-cli-status">
              <strong>{agent.installed?(agent.cliVersion?`CLI ${agent.cliVersion}`:'已检测到 CLI'):'未检测到 CLI'}</strong>
              <div className="codex-config-actions">
                {manualModel&&!customGateway&&<button type="button" className="button secondary"
                  onClick={()=>selectAuthentication('claude-custom-api')}><Glyph name="plug" size={13}/>自定义 API</button>}
                <a href={installGuides[executor]} target="_blank" rel="noreferrer">CLI 安装说明 <Glyph name="next" size={12}/></a>
              </div>
            </div>
            <div className="codex-config-connection-fields">
              {observed&&!connectionChanged&&<p>{observed}</p>}
              <label><span>项目启用</span><input type="checkbox" checked={draft.enabled} disabled={awaitingGoogle}
                onChange={event=>update({enabled:event.target.checked})}/></label>
              <label><span>CLI 路径</span><input value={draft.executablePath} placeholder={agent.detectedExecutable??'自动识别或填写绝对路径'} spellCheck={false} disabled={awaitingGoogle}
                onChange={event=>update({executablePath:event.target.value})}/></label>
              <label><span>登录方式</span><AppSelect label="登录方式" value={draft.authentication??cliDefaultAuthentication[executor]} disabled={busy||awaitingGoogle}
                onChange={event=>selectAuthentication(event.target.value as CliAuthentication)}>
                <option value={cliDefaultAuthentication[executor]}>{executor==='claude-code'?'复用本机登录':'Google 登录'}</option>
                <option value="cli-api-key">{executor==='claude-code'?'Anthropic API Key':'Gemini API Key'}</option>
                {manualModel&&<option value="claude-custom-api">自定义 API</option>}
              </AppSelect></label>
              {customGateway&&<>
                <label><span>API 基础地址</span><input ref={gatewayAddress} type="url" value={draft.gatewayBaseURL} placeholder="https://openrouter.ai/api"
                  autoComplete="off" spellCheck={false}
                  onChange={event=>{
                    if(apiKey===null)setKeys(previous=>({...previous,[executor]:undefined}));
                    update({gatewayBaseURL:event.target.value,effort:''});
                  }}/></label>
                <label><span>Key 发送方式</span><AppSelect label="Key 发送方式" value={draft.gatewayCredentialHeader}
                  onChange={event=>{
                    if(apiKey===null)setKeys(previous=>({...previous,[executor]:undefined}));
                    update({gatewayCredentialHeader:event.target.value as ClaudeGateway['credentialHeader'],effort:''});}}>
                  <option value="authorization">Bearer Token</option>
                  <option value="x-api-key">x-api-key</option>
                </AppSelect></label>
              </>}
              {keyMode&&<div className="codex-config-credential">
                <label><span>API Key</span><input type="password" autoComplete="off" spellCheck={false} value={apiKey??''}
                  placeholder={apiKey===null?'保存后移除':keyConfigured?'已保存 · 输入新 Key 替换':
                    customGateway?'第三方服务 API Key':executor==='antigravity'?'Gemini API Key':'Anthropic API Key'}
                  onChange={event=>{setFeedback('');const value=event.target.value;setKeys(previous=>({...previous,[executor]:value||undefined}));}}/></label>
                {keyConfigured&&<button type="button" className="button secondary" onClick={()=>setKeys(previous=>({...previous,[executor]:apiKey===null?undefined:null}))}>{apiKey===null?'撤销':'移除'}</button>}
              </div>}
              {!showModels&&manualModel&&<label><span>模型 ID</span><input value={draft.model}
                placeholder={customGateway?'可手填，或保存后从列表选择':'跟随 CLI'} spellCheck={false}
                onChange={event=>update({model:event.target.value,effort:''})}/></label>}
              {customGateway&&<p>地址需兼容 Anthropic Messages。可手填模型 ID。选择模型后，「检测连接」会发送一条短测试请求。</p>}
              {googleSelected&&(googleLogin?<form className="codex-config-google" aria-label="Google 授权" onSubmit={event=>{event.preventDefault();submitGoogleCode();}}>
                <p>在浏览器完成授权后，将页面显示的授权码粘贴到这里。</p>
                <label><span>授权码</span><input type="password" autoComplete="off" spellCheck={false}
                  value={googleCode} onChange={event=>setGoogleCode(event.target.value)}/></label>
                <div className="codex-config-actions">
                  <a ref={googleLink} className="button secondary" href={googleLogin.authorizationUrl} target="_blank" rel="noopener noreferrer">
                    打开 Google 授权 <Glyph name="arrow" size={13}/>
                  </a>
                  <button className="button secondary" type="button" onClick={()=>void cancelGoogleLogin()}>取消</button>
                  <button className="button primary" type="submit" disabled={!googleCode.trim()}>完成登录</button>
                </div>
              </form>:null)}
              {!awaitingGoogle&&<div className="codex-config-actions">
                {googleSelected&&<button className="button secondary" type="button" disabled={dirty||!agent.installed}
                 onClick={()=>void startGoogleLogin()}>{agent.authMode==='google'?'重新授权':'使用 Google 登录'}</button>}
                <button type="button" className="button secondary" disabled={dirty||!agent.installed} onClick={reconnect}>检测连接</button>
              </div>}
            </div>
            </div>}
        </fieldset>}
        {(loading||status)&&<p className="codex-config-feedback" role={error?'alert':'status'}>{loading?`正在读取 ${name} 配置…`:status}</p>}
        {agent&&draft&&<footer className="codex-config-footer">
            {dirty&&agent.enabled&&<small>保存会中止此项目正在运行的 {name} 调用。</small>}
            {showModels&&<button type="button" className="codex-config-connection" disabled={busy||awaitingGoogle} aria-controls={connectionId}
              aria-expanded={connectionExpanded} onClick={()=>setConnectionOpen(open=>!open)}>
              <Glyph name="plug" size={15}/><span>连接设置</span>
              <span className="codex-config-readiness" data-ready={agent.assignmentReady===true}>
                {agent.assignmentReady?'已就绪':customGateway&&agent.transportReady&&!agent.defaultTaskModel?'待选模型':'待连接'}
              </span>
              <Glyph name={connectionExpanded?'chevron':'next'} size={13}/>
            </button>}
            <button type="button" className="button primary" disabled={busy||!dirty||customGateway&&!draft.gatewayBaseURL.trim()}
              onClick={()=>save()}>{busy?'正在处理…':'保存配置'}</button>
        </footer>}
      </div>
    </div>
  </dialog>;
}
