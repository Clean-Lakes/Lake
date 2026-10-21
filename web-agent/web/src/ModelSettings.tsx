import {StrategySettings} from "./StrategySettings";
import {MCPSettings,SkillSettings} from "./ExtensionSettings";
import {ProviderIcon} from "./ProviderIcon";
import {Glyph} from "./Icons";
import {AppSelect} from "./AppSelect";
import {useAutoRefresh} from "./useAutoRefresh";
import {reuseUnchanged} from "./snapshotUpdates";
import {useEffect, useRef, useState} from "react";
import {setThemePreference, themePreference, type ThemePreference} from "./appearance";
import type {AvailableModels, ModelProvider, ProviderCatalog, ProviderModel} from "../../shared/contracts";
import {api, readableError, type ModelSyncState} from "./api";
import {contextLabel, discoveredModels, providerDraft, providerPayload, providerProtocolBaseURL, type ProviderDraft} from "./modelProviderState";
import {parseSendShortcut, type SendShortcut} from "./composerKeyboard";
import {ProviderQuickSetup,ProviderModelPicker} from "./ProviderSetup";
import {type ProviderPreset} from "./providerPresets";
import "./modelSettings.css";

const formats = [["openai","OpenAI · Chat Completions"],["openai-response","OpenAI · Responses"],["claude","Anthropic · Messages"],["gemini","Gemini · Generate Content"],["azure-gpt","Azure OpenAI"],["ollama","Ollama"]];
const magpieSelection = "__magpie__";
const newProviderSelection = "__new_provider__";

function Switch({checked,label,onChange,disabled=false}: {checked:boolean;label:string;onChange:(value:boolean)=>void;disabled?:boolean}) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`provider-switch ${checked ? "on" : ""}`} disabled={disabled} onClick={() => onChange(!checked)}><span/></button>;
}
export function ModelSettings({onClose,onChanged,sendShortcut,onShortcutChange,completionEnabled,onCompletionEnabledChange,onSessionConfig,onProjectMemory,projectId,projectName,ignoreProjectMemory,onIgnoreProjectMemoryChange}: {
  onClose:()=>void;onChanged:()=>Promise<void>;sendShortcut:SendShortcut;onShortcutChange:(value:SendShortcut)=>void;onSessionConfig?:()=>void;onProjectMemory?:()=>void;projectId?:string;projectName?:string;
  completionEnabled:boolean;onCompletionEnabledChange:(value:boolean)=>void;
  ignoreProjectMemory:boolean;onIgnoreProjectMemoryChange:(value:boolean)=>void;
}) {
  const [tab,setTab] = useState("models");
 const [extensionBusy,setExtensionBusy]=useState(false);
  const [catalog,setCatalog] = useState<ProviderCatalog>({providers:[],activeProviderId:"",activeModelId:""});
  const [magpieModel,setMagpieModel] = useState<{name:string}|null>(null);
  const [magpieModels,setMagpieModels] = useState<AvailableModels|null>(null);
  const [drafts,setDrafts] = useState<Record<string,ProviderDraft>>({});
  const [selected,setSelected] = useState("");
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState("");
  const [error,setError] = useState("");
  const [result,setResult] = useState<{ok:boolean;message:string}|null>(null);
  const [editor,setEditor] = useState<ProviderModel|null>(null);
  const [discovery,setDiscovery] = useState<{id:string;available:AvailableModels}|null>(null);
  const [deleteConfirm,setDeleteConfirm] = useState(false);
  const [detection,setDetection] = useState<{id:string;status:string;total:number;complete:number}|null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef=useRef(onClose);closeRef.current=onClose;
  const busyRef=useRef(busy);busyRef.current=busy||extensionBusy?"busy":"";
  const draft = drafts[selected];
  const isBusy = !!busy||extensionBusy;
  function applyModelState({providers:next,settings:active,available}: Pick<ModelSyncState,"providers"|"settings"|"available">) {
    setCatalog(current => reuseUnchanged(current,next));
    const magpie = active.magpie || (active.managedBy === "magpie" ? {name:active.name} : null);
    setMagpieModel(current => reuseUnchanged(current,magpie));
    setMagpieModels(current => reuseUnchanged(current,available && magpie ? {...available,entries:available.entries?.filter(entry => entry.providerId==="magpie"),activeModelId:next.activeProviderId==="magpie" ? available.activeModelId : ""} : null));
    setDrafts(current => reuseUnchanged(current,Object.fromEntries([...Object.entries(current).filter(([,value]) => value.isNew), ...next.providers.map(provider => [provider.id,current[provider.id]?.dirty ? current[provider.id] : providerDraft(provider)])])));
    setSelected(current => current && (current===magpieSelection || current===newProviderSelection || current.startsWith("draft-") || next.providers.some(provider => provider.id===current)) ? current : next.activeProviderId==="magpie" ? magpieSelection : next.activeProviderId || (magpie ? magpieSelection : next.providers[0]?.id) || newProviderSelection);
  }
  useAutoRefresh(api.modelState, applyModelState, !loading && !isBusy);
  async function refreshDetectedProviders() {
    const next=await api.providers();
    setCatalog(next);
    setDrafts(current => ({...current,...Object.fromEntries(next.providers.filter(provider => !current[provider.id]?.dirty).map(provider => [provider.id,providerDraft(provider)]))}));
    await onChanged();
  }
  async function load() {
    setLoading(true);setError("");
    try {
      const [next,active] = await Promise.all([api.providers(),api.modelSettings()]);
      const magpie = active.magpie || (active.managedBy === "magpie" ? {name:active.name} : null);
      const available=magpie ? await api.availableModels() : null;
      applyModelState({providers:next,settings:active,available});
    } catch (e) {setError(readableError(e));} finally {setLoading(false);}
  }
  useEffect(() => {void load();}, []);
  useEffect(() => {
    if (detection?.status !== "running") return;
    let active=true;
    let pending=false;
    const timer=window.setInterval(async () => {
      if (pending) return;
      pending=true;
      try {
        const status=await api.providerCapabilityStatus(detection.id);
        if (!active) return;
        setDetection({id:detection.id,...status});
        if (status.status === "complete") {
          if (active) await refreshDetectedProviders();
        }
      } catch { /* A later settings refresh can recover after a transient failure. */ }
      finally { pending=false; }
    }, 1500);
    return () => {active=false;window.clearInterval(timer);};
  }, [detection?.id,detection?.status]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement|null;
    dialogRef.current?.focus();
    const key = (event:KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {event.preventDefault();event.stopPropagation();closeRef.current();}
      if (event.key !== "Tab") return;
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]') || [])].filter(item => item.getClientRects().length);
      const first=items[0],last=items[items.length-1];
      if (event.shiftKey && (document.activeElement===first || document.activeElement===dialogRef.current)) {event.preventDefault();last?.focus();}
      else if (!event.shiftKey && (document.activeElement===last || document.activeElement===dialogRef.current)) {event.preventDefault();first?.focus();}
    };
    document.addEventListener("keydown",key);
    return () => {document.removeEventListener("keydown",key);previous?.focus();};
  }, []);
  function update(patch:Partial<ProviderDraft>) {
    if (["baseURL","protocol","apiKey","clearKey"].some(key => key in patch)) setDiscovery(null);
    setDrafts(current => ({...current,[selected]:{...current[selected]!,...patch,dirty:true}}));setResult(null);
  }
  function choose(id:string) {setSelected(id);setEditor(null);setDiscovery(null);setError("");setResult(null);setDeleteConfirm(false);}
  function addProvider(preset:ProviderPreset) {
    const id="draft-"+crypto.randomUUID();
    const fresh:ProviderDraft={...providerDraft({id,name:preset.name,baseURL:preset.baseURL,protocol:preset.protocol,enabled:true,keyConfigured:false,models:[]}),isNew:true,dirty:true};
    setDrafts(current => ({...current,[id]:fresh}));choose(id);
  }
  function acceptCatalog(next:ProviderCatalog,id:string) {
    setCatalog(next);
    setDrafts(current => {
      const nextDrafts={...current};delete nextDrafts[selected];
      for (const provider of next.providers) if (provider.id===id || !nextDrafts[provider.id]?.dirty) nextDrafts[provider.id]=providerDraft(provider);
      return nextDrafts;
    });setSelected(id);
  }
  async function saveCurrent():Promise<ModelProvider> {
    if (!draft) throw new Error("请选择供应商");
    if (editor) throw new Error("请先完成模型编辑");
    if (discovery) throw new Error("请先添加所选模型或关闭模型选择");
    if (!draft.dirty && !draft.isNew) return draft;
    const next=await api.saveProvider(draft.isNew ? null : draft.id,providerPayload(draft));
    const saved=next.providers.find(provider => provider.id===next.savedProviderId)!;
    acceptCatalog(next,saved.id);await onChanged();
    const status=await api.providerCapabilityStatus(saved.id);
    setDetection({id:saved.id,...status});
    if (status.status === "complete") await refreshDetectedProviders();
    return saved;
  }
  async function run(kind:string, action:()=>Promise<void>) {
    if (isBusy) return;setBusy(kind);setError("");setResult(null);
    try {await action();} catch(e) {setError(readableError(e));} finally {setBusy("");}
  }
  async function save() {await saveCurrent();setResult({ok:true,message:"供应商已保存；图片与思考级别能力会在后台识别。"});}
  async function detectImages() {
    if (!draft || draft.isNew || draft.dirty) throw new Error("请先保存供应商配置");
    const status=await api.detectProviderCapabilities(draft.id);
    setDetection({id:draft.id,...status});
    if (status.status === "complete") await refreshDetectedProviders();
    setResult({ok:true,message:"已开始在后台重新识别图片与思考级别能力。"});
  }
  function requestInput() {
    const payload=providerPayload(draft!);
    return {baseURL:payload.baseURL,protocol:payload.protocol,...("apiKey" in payload ? {apiKey:payload.apiKey} : {})};
  }
  async function test() {
    const model=draft?.models.find(item => item.enabled) || draft?.models[0];
    if (!model) throw new Error("请先添加一个模型");
    setResult(await api.testProvider(draft!.isNew ? "new" : draft!.id,{...requestInput(),model:model.name}));
  }
  async function discover() {
    const found=await api.discoverProvider(draft!.isNew ? "new" : draft!.id,requestInput());
    if (!found.models?.length) throw new Error(found.message || "接口没有返回模型列表，可手动添加模型 ID。");
    setDiscovery({id:crypto.randomUUID(),available:found});
  }
  function addDiscoveredModels(names:string[]) {
    if (!draft || !discovery) return;
    const found=discovery.available;
    const models=discoveredModels(draft.models,names,found.imageInputCapabilities,found.reasoningCapabilities,found.contextLimits);
    if (models.length>256) {setError("每个供应商最多添加 256 个模型");return;}
    update({models});setDiscovery(null);setResult({ok:true,message:`已添加 ${models.length-draft.models.length} 个模型，保存供应商后生效。`});
  }

  async function activate(modelId:string) {
    const saved=await saveCurrent();
    const next=await api.selectProviderModel(saved.id,modelId);setCatalog(next);await load();await onChanged();
  }
  async function activateMagpie(modelId:string) {
    await api.selectProviderModel("magpie",modelId);
    await load();
    await onChanged();
  }
  async function remove() {
    if (!draft) return;
    let next=catalog;
    if (!draft.isNew) {next=await api.deleteProvider(draft.id);setCatalog(next);await onChanged();}
    setDrafts(current => {const remaining={...current};delete remaining[selected];return remaining;});
    choose(magpieModel ? magpieSelection : next.activeProviderId || next.providers.find(provider => provider.id!==selected)?.id || Object.keys(drafts).find(id => id!==selected && drafts[id]?.isNew) || magpieSelection);
  }
  function startModel(model?:ProviderModel) {
    setDiscovery(null);
    setEditor(model ? {...model} : {id:crypto.randomUUID(),name:"",displayName:"",enabled:true,contextWindow:0,supportsImageInput:false,supportsImageOutput:false,imageInputMode:"auto"});setError("");
  }
  function commitModel() {
    if (!editor || !draft) return;
    if (!editor.name.trim()) {setError("请输入模型 ID");return;}
    if (draft.models.some(model => model.id!==editor.id && model.name===editor.name.trim())) {setError("此供应商已经有同名模型");return;}
    if (editor.contextWindow && (!Number.isInteger(editor.contextWindow) || editor.contextWindow<2048 || editor.contextWindow>2_000_000)) {setError("上下文须为 2048～2000000 tokens，留空则自动检测");return;}
    const models=draft.models.some(model => model.id===editor.id) ? draft.models.map(model => model.id===editor.id ? editor : model) : [...draft.models,editor];
    update({models});setEditor(null);setError("");
  }
  const rows=Object.values(drafts);
  return <div className="modal-scrim"><div ref={dialogRef} tabIndex={-1} className="modal model-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="model-settings-title">
    <header className="model-settings-header"><div><h2 id="model-settings-title">{tab==="models"?"模型设置":tab==="mcp"?"MCP 设置":tab==="strategy"?"策略资产":tab==="skills"?"Skills 设置":tab==="appearance"?"外观设置":"对话设置"}</h2><p>{tab==="mcp"?"连接外部工具，在对话中按需调用。":tab==="strategy"?"维护可见的工作偏好与方法，明确采用后应用到会话。":tab==="skills"?"管理可复用的操作流程与本机技能目录。":tab==="appearance" ? "选择工作台主题，立即生效并自动保存。" : tab==="conversation" ? "配置消息输入、补齐建议与会话偏好。" : "配置供应商与模型，在聊天中随时切换。"}</p></div><button className="icon-button" aria-label="关闭设置" disabled={isBusy} onClick={onClose}><Glyph name="close" size={18}/></button></header>
    <div className="model-settings-tabs" role="tablist" aria-label="设置分类"><button role="tab" id="model-settings-tab" aria-controls="model-settings-panel" aria-selected={tab==="models"} disabled={isBusy} onClick={() => setTab("models")}>模型</button><button role="tab" id="mcp-settings-tab" aria-controls="mcp-settings-panel" aria-selected={tab==="mcp"} disabled={isBusy} onClick={()=>setTab("mcp")}><Glyph name="plug" size={15}/>MCP</button><button role="tab" id="skills-settings-tab" aria-controls="skills-settings-panel" aria-selected={tab==="skills"} disabled={isBusy} onClick={()=>setTab("skills")}><Glyph name="book" size={15}/>Skills</button><button role="tab" id="strategy-settings-tab" aria-controls="strategy-settings-panel" aria-selected={tab==="strategy"} disabled={isBusy} onClick={()=>setTab("strategy")}>策略资产</button><button role="tab" id="conversation-settings-tab" aria-controls="conversation-settings-panel" aria-selected={tab==="conversation"} disabled={isBusy} onClick={() => setTab("conversation")}>对话</button><button role="tab" id="appearance-settings-tab" aria-controls="appearance-settings-panel" aria-selected={tab==="appearance"} disabled={isBusy} onClick={() => setTab("appearance")}>外观</button></div>
    {tab==="strategy"?<StrategySettings projectId={projectId} projectName={projectName} onBusyChange={setExtensionBusy}/>:tab==="mcp"?<MCPSettings onBusyChange={setExtensionBusy}/>:tab==="skills"?<SkillSettings onBusyChange={setExtensionBusy}/>:tab==="appearance" ? <AppearanceSettings/> : tab==="conversation" ? <section id="conversation-settings-panel" role="tabpanel" aria-labelledby="conversation-settings-tab" className="model-conversation"><label className="field-label">发送快捷键<AppSelect icon={<Glyph name="return" size={15}/>} value={sendShortcut} onChange={event => onShortcutChange(parseSendShortcut(event.target.value))}><option value="enter">Enter 发送，Shift + Enter 换行</option><option value="command-enter">Command / Ctrl + Enter 发送，Enter 换行</option></AppSelect></label><p className="settings-note">立即生效并自动保存。输入法确认候选词时不会发送消息。</p><div className="model-conversation-memory"><h3>文字补齐</h3><label><input type="checkbox" checked={completionEnabled} onChange={event=>onCompletionEnabledChange(event.target.checked)}/>自动建议后续文字</label><p className="settings-note">停顿后使用当前模型、当前会话最近的提问与常用表达生成灰色建议。Tab 接受，Esc 忽略。会调用模型，立即生效并自动保存。</p></div>{onProjectMemory && <div className="model-conversation-memory"><h3>项目记忆</h3><p className="settings-note">{projectName} · 管理记忆内容和使用方式</p><button type="button" className="button secondary" onClick={onProjectMemory}>配置项目记忆</button></div>}{onSessionConfig && <div className="model-conversation-memory"><h3>当前会话</h3><label><input type="checkbox" checked={ignoreProjectMemory} onChange={event => onIgnoreProjectMemoryChange(event.target.checked)}/>本轮忽略项目记忆</label><p className="settings-note">仅对下一条消息生效，发送后自动取消。</p><button className="button secondary" onClick={onSessionConfig}>当前会话配置</button></div>}</section> : <div id="model-settings-panel" role="tabpanel" aria-labelledby="model-settings-tab" className="model-settings-body">
      <aside className="provider-rail"><div className="provider-rail-title"><span>模型来源 <small>{rows.length+1}</small></span><button className="icon-button" aria-label="刷新模型来源" title="刷新模型来源" disabled={loading || isBusy} onClick={() => void load()}><Glyph name="refresh" size={14}/></button></div><button type="button" className={`provider-item magpie-provider-item ${selected===magpieSelection ? "selected" : ""}`} disabled={isBusy} onClick={() => choose(magpieSelection)}><span className="provider-avatar magpie-avatar"><img src="/magpie.svg" alt=""/></span><span className="provider-item-copy"><strong>Magpie</strong><small>{magpieModel ? `${catalog.activeProviderId==="magpie" ? "当前使用" : "已接入"} · ${magpieModel.name}` : "未接入此 Lake 实例"}</small></span><span className={`provider-state ${magpieModel ? "enabled" : ""}`} title={magpieModel ? "已接入" : "未接入"}/></button><button className="provider-add" disabled={loading || isBusy} onClick={() => choose(newProviderSelection)}><Glyph name="plus" size={14}/>添加供应商</button><div className="provider-list" aria-label="供应商列表">
        {loading && <p className="settings-note">正在加载…</p>}{rows.map(provider => <button key={provider.id} className={`provider-item ${selected===provider.id ? "selected" : ""}`} disabled={isBusy} onClick={() => choose(provider.id)}><span className="provider-avatar"><ProviderIcon name={provider.name} baseURL={provider.baseURL} size={21}/></span><span className="provider-item-copy"><strong>{provider.name}</strong><small>{provider.isNew ? "新供应商" : provider.id===catalog.activeProviderId ? "当前使用" : provider.enabled ? `${provider.models.filter(model => model.enabled).length} 个模型 · 手动配置` : "已停用"}{provider.dirty ? " · 未保存" : ""}</small></span><span className={`provider-state ${provider.enabled ? "enabled" : ""}`} title={provider.enabled ? "已启用" : "已停用"}/></button>)}</div></aside>
      <section className="provider-detail" aria-label="供应商配置">{selected===newProviderSelection ? <ProviderQuickSetup onSelect={addProvider}/> : selected===magpieSelection ? <div className="magpie-detail"><div className="magpie-detail-heading"><span className="magpie-detail-icon"><img src="/magpie.svg" alt=""/></span><div><h3>Magpie</h3><span className={magpieModel ? "magpie-connected" : ""}>{magpieModel ? catalog.activeProviderId==="magpie" ? "已接入 · 正在用于 Lake 对话" : "已接入 · 可随时切换使用" : "未接入此 Lake 实例"}</span></div></div>{magpieModel ? <><div className="magpie-current-model"><span>Magpie 所选模型</span><strong>{magpieModel.name}</strong></div><p>Magpie 的 Agent 页面设置默认模型；在下方或聊天输入区切换 Lake 当前使用的模型。</p><MagpieModelList available={magpieModels} busy={isBusy} onSelect={modelId => void run("select",() => activateMagpie(modelId))}/><p>Magpie 与手动供应商可以同时使用；在这里或聊天输入区选择模型，无需停用 Magpie 接入。</p></> : <><p>在 Magpie 的 Agent 页面安装并接入 Lake，然后为 Lake 选择模型；接入后这里会自动同步模型目录和当前模型。</p><p>Lake Dev 使用独立配置目录。若要在这里联调 Magpie，请单独安装插件仓库中的 lake-dev.agent.js。</p></>}</div> : draft ? <>
        <div className="provider-detail-heading"><div className="provider-detail-title"><span className="provider-detail-icon"><ProviderIcon name={draft.name} baseURL={draft.baseURL} size={24}/></span><div><h3>{draft.name || "新供应商"}</h3><span>{draft.dirty ? "有未保存的更改" : "已保存"}</span></div></div><div className="provider-detail-actions"><button type="button" className="provider-text-button danger-text" disabled={isBusy} onClick={() => draft.isNew ? void run("delete",remove) : setDeleteConfirm(true)}>{draft.isNew ? "移除草稿" : "删除供应商"}</button><Switch label="启用供应商" checked={draft.enabled} disabled={isBusy} onChange={enabled => update({enabled})}/></div></div>
        {deleteConfirm && <div className="provider-delete-confirm" role="group" aria-label="确认删除供应商"><span>删除「{draft.name}」及其模型？</span><button type="button" className="provider-text-button" disabled={isBusy} onClick={() => setDeleteConfirm(false)}>取消</button><button type="button" className="provider-text-button danger-text" disabled={isBusy} onClick={() => void run("delete",remove)}>确认删除</button></div>}
        <fieldset disabled={isBusy} className="provider-fields">
        <div className="provider-connection-grid">
          <label className="field-label provider-field-wide">供应商名称<input maxLength={120} value={draft.name} onChange={event => update({name:event.target.value})}/></label>
          <label className="field-label provider-field-wide">Base URL<input spellCheck={false} autoComplete="off" maxLength={2000} placeholder="https://api.example.com/v1" value={draft.baseURL} onChange={event => update({baseURL:event.target.value})}/></label>
          <label className="field-label">API 格式<AppSelect icon={<Glyph name="code" size={15}/>} value={draft.protocol} onChange={event => update({protocol:event.target.value,baseURL:providerProtocolBaseURL(draft.baseURL,event.target.value)})}>{formats.map(([id,label]) => <option key={id} value={id}>{label}</option>)}</AppSelect></label>
          <label className="field-label">API Key<div className="provider-key-row"><input type="password" autoComplete="new-password" spellCheck={false} maxLength={4096} placeholder={draft.clearKey ? "保存后清除密钥" : draft.keyConfigured ? "已保存密钥，留空保持不变" : "输入密钥；本地模型可留空"} value={draft.apiKey} onChange={event => update({apiKey:event.target.value,clearKey:false})}/>{draft.keyConfigured && <button type="button" className="provider-text-button" onClick={() => update({clearKey:!draft.clearKey,apiKey:""})}>{draft.clearKey ? "撤销清除" : "清除"}</button>}</div></label>
        </div>
        <div className="provider-model-heading"><h4>模型列表 <small>{draft.models.length}</small></h4><div><button type="button" className="provider-text-button" disabled={draft.isNew || draft.dirty || !!editor || !!discovery} onClick={() => void run("detect-images",detectImages)}>重新识别模型能力</button><button type="button" className="provider-text-button" disabled={!draft.baseURL.trim() || !!editor || !!discovery} onClick={() => void run("discover",discover)}>{busy==="discover" ? "获取中…" : "从 API 选择模型"}</button><button type="button" className="provider-text-button" disabled={!!editor || !!discovery} onClick={() => startModel()}><Glyph name="plus" size={13}/>手动添加</button></div></div>
        {detection?.id===draft.id && detection.status==="running" && <p className="settings-note" role="status">模型能力后台识别中：{detection.complete}/{detection.total}</p>}
        {((!editor && !discovery) || draft.models.length>0) && <div className="provider-model-list">{!draft.models.length && !editor && <div className="provider-model-empty">从 API 选择需要的模型，也可以手动添加模型 ID。</div>}{draft.models.map(model => <div className="provider-model-row" key={model.id}><div className="provider-model-name"><strong title={model.name}>{model.displayName || model.name}</strong>{model.displayName && <small>{model.name}</small>}</div><span className="provider-context" title="上下文窗口">{contextLabel(model.contextWindow)}</span><button type="button" className={`provider-use ${catalog.activeProviderId===draft.id && catalog.activeModelId===model.id ? "active" : ""}`} aria-label={`使用模型 ${model.name}`} title="用于聊天" disabled={!draft.enabled || !model.enabled || !!editor || !!discovery} onClick={() => void run("select",() => activate(model.id))}>{catalog.activeProviderId===draft.id && catalog.activeModelId===model.id ? "使用中" : "使用"}</button><button className="provider-row-icon" aria-label={`编辑模型 ${model.name}`} disabled={!!editor} onClick={() => startModel(model)}><Glyph name="edit" size={14}/></button><button className="provider-row-icon" aria-label={`删除模型 ${model.name}`} disabled={!!editor} onClick={() => update({models:draft.models.filter(item => item.id!==model.id)})}><Glyph name="trash" size={14}/></button><Switch label={`启用模型 ${model.name}`} checked={model.enabled} onChange={enabled => update({models:draft.models.map(item => item.id===model.id ? {...item,enabled} : item)})}/></div>)}</div>}
        {discovery && <ProviderModelPicker key={discovery.id} available={discovery.available} current={draft.models} onAdd={addDiscoveredModels} onCancel={() => setDiscovery(null)}/>}
        {editor && <ProviderModelEditor model={editor} editing={draft.models.some(model => model.id===editor.id)} onChange={setEditor} onCancel={() => {setEditor(null);setError("");}} onCommit={commitModel}/>}
        </fieldset>
      </> : <div className="provider-empty"><span><Glyph name="plug" size={32}/></span><h3>添加你的模型供应商</h3><p>同一供应商可配置多个模型，聊天时直接切换。</p><button className="button primary" disabled={loading || isBusy} onClick={() => choose(newProviderSelection)}><Glyph name="plus" size={14}/>添加供应商</button></div>}</section>
    </div>}
    {tab!=="strategy"&&tab!=="mcp"&&tab!=="skills"&&<footer className="model-settings-footer"><div className="provider-feedback" aria-live="polite">{error ? <p className="form-error" role="alert">{error}</p> : result ? <p className={result.ok ? "provider-success" : "form-error"}>{result.message}</p> : <p>{tab==="models" ? selected===magpieSelection ? magpieModel ? "Magpie 与手动供应商的模型可随时切换。" : "接入后会自动同步 Magpie 模型。" : discovery ? "勾选模型并添加到列表后，保存供应商使配置生效。" : selected===newProviderSelection ? "厂商预设会自动填写接入地址和 API 格式。" : editor ? "完成模型编辑后，保存供应商使配置生效。" : magpieModel ? "保存后点击「使用」即可切换模型，无需停用 Magpie 接入。" : "每个供应商独立保存密钥。保存后立即生效。" : tab==="appearance" ? "外观偏好自动保存。" : "对话偏好自动保存。"}</p>}</div>{tab==="models" && draft && <div className="provider-footer-actions"><button className="button secondary" disabled={isBusy || !draft.baseURL.trim() || !draft.models.length || !!editor || !!discovery} onClick={() => void run("test",test)}>{busy==="test" ? "测试中…" : "测试连接"}</button><button className="button primary" disabled={isBusy || !draft.baseURL.trim() || !draft.name.trim() || !!editor || !!discovery || !draft.dirty} onClick={() => void run("save",save)}>{busy==="save" ? "保存中…" : "保存供应商"}</button></div>}</footer>}
  </div></div>;
}

function ProviderModelEditor({model,editing,onChange,onCancel,onCommit}: {
  model:ProviderModel;editing:boolean;onChange:(model:ProviderModel)=>void;onCancel:()=>void;onCommit:()=>void;
}) {
  const editorRef=useRef<HTMLDivElement>(null);
  useEffect(() => {editorRef.current?.scrollIntoView({block:"nearest"});}, []);
  return <div ref={editorRef} className="provider-model-editor" role="group" aria-labelledby="provider-model-editor-title">
    <div className="provider-editor-heading"><h4 id="provider-model-editor-title">{editing ? "编辑模型" : "添加模型"}</h4><p>填写模型 ID，其他设置可保持默认。</p></div>
    <div className="provider-model-editor-grid">
      <label className="field-label">模型 ID<input autoFocus aria-required="true" spellCheck={false} maxLength={200} placeholder="例如 mimo-v2.6-pro" value={model.name} onChange={event => onChange({...model,name:event.target.value})}/></label>
      <label className="field-label">显示名称<input maxLength={120} placeholder="默认使用模型 ID" value={model.displayName || ""} onChange={event => onChange({...model,displayName:event.target.value})}/></label>
    </div>
    <div className="provider-model-options">
      <label className="field-label">上下文 tokens<input type="number" min={2048} max={2000000} step={1} placeholder="自动检测" value={model.contextWindow || ""} onChange={event => onChange({...model,contextWindow:event.target.value ? Number(event.target.value) : 0})}/></label>
      <label className="field-label">图片输入<AppSelect icon={<Glyph name="image" size={15}/>} value={model.imageInputMode || (model.supportsImageInput ? "on" : "auto")} onChange={event => {const mode=event.target.value as "auto" | "on" | "off";onChange({...model,imageInputMode:mode,imageInputDetected:undefined,supportsImageInput:mode==="on"});}}><option value="auto">自动识别</option><option value="on">支持（手动）</option><option value="off">不支持（手动）</option></AppSelect></label>
      <div className="field-label provider-image-output"><span>图片输出</span><div className="provider-output-control"><span>{model.supportsImageOutput ? "已开启" : "未开启"}</span><Switch label="启用图片输出" checked={model.supportsImageOutput} onChange={enabled => onChange({...model,supportsImageOutput:enabled})}/></div></div>
    </div>
    <div className="provider-editor-actions"><button type="button" className="provider-text-button" onClick={onCancel}>取消</button><button type="button" className="button primary" onClick={onCommit}>{editing ? "保存模型修改" : "添加到列表"}</button></div>
  </div>;
}

function MagpieModelList({available,busy,onSelect}: {available:AvailableModels|null;busy:boolean;onSelect:(id:string)=>void}) {
  const [query,setQuery] = useState("");
  const entries=(available?.entries || []).filter(entry => entry.providerId==="magpie" && `${entry.displayName} ${entry.name}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="magpie-models"><div className="provider-model-heading"><h4>可用模型 <small>{available?.entries?.length || 0}</small></h4></div><label className="visually-hidden" htmlFor="magpie-model-search">搜索 Magpie 模型</label><input id="magpie-model-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索模型"/><div className="provider-model-list magpie-model-list" role="region" aria-label="Magpie 可用模型" tabIndex={0}>{entries.length ? entries.map(entry => <div className="provider-model-row" key={entry.modelId}><div className="provider-model-name"><strong title={entry.name}>{entry.displayName}</strong>{entry.displayName!==entry.name && <small>{entry.name}</small>}</div><span className="provider-context" title="上下文窗口">{contextLabel(entry.contextWindow)}</span><button type="button" className={`provider-use ${entry.modelId===available?.activeModelId ? "active" : ""}`} disabled={busy || entry.modelId===available?.activeModelId} aria-label={`使用 Magpie 模型 ${entry.name}`} onClick={() => onSelect(entry.modelId)}>{entry.modelId===available?.activeModelId ? "使用中" : "使用"}</button></div>) : <div className="provider-model-empty">{query ? "没有匹配的模型" : "Magpie 尚未提供模型目录；请更新 Lake 插件后在 Magpie 中刷新接入。"}</div>}</div></div>;
}

function AppearanceSettings() {
  const [preference, setPreference] = useState<ThemePreference>(themePreference);
  return <section id="appearance-settings-panel" role="tabpanel" aria-labelledby="appearance-settings-tab" className="model-conversation">
    <h3>工作台主题</h3><p className="settings-note">导航、对话、终端和弹窗使用同一套主题。</p>
    <div className="theme-options" role="radiogroup" aria-label="工作台主题">{([['light','浅色'],['dark','深色'],['system','跟随系统']] as const).map(([value,label]) => <button key={value} type="button" role="radio" aria-checked={preference===value} className="theme-choice" tabIndex={preference===value ? 0 : -1} onKeyDown={event => { if (!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key)) return; event.preventDefault(); const values:ThemePreference[]=["light","dark","system"]; const next=values[(values.indexOf(value)+(event.key==="ArrowLeft"||event.key==="ArrowUp"?2:1))%3]!; setPreference(next); setThemePreference(next); const buttons=event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button"); buttons?.[values.indexOf(next)]?.focus(); }} onClick={() => { setPreference(value); setThemePreference(value); }}><span className="theme-preview" data-preview={value} aria-hidden="true"><i/><span/></span><strong>{label}</strong></button>)}</div>
  </section>;
}
