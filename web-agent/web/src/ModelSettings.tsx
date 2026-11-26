import {GatewaySettings,type GatewayTaskTarget} from './GatewaySettings';
import {MCPSettings,SkillSettings} from "./ExtensionSettings";
import {ProviderIcon} from "./ProviderIcon";
import {Glyph} from "./Icons";
import {SaveAction} from "./SaveAction";
import {AppSelect} from "./AppSelect";
import {useAutoRefresh} from "./useAutoRefresh";
import {reuseUnchanged} from "./snapshotUpdates";
import {useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref} from "react";
import {setThemePreference, themePreference, type ThemePreference} from "./appearance";
import type {AvailableModels, ModelProvider, ProviderCatalog, ProviderModel} from "../../shared/contracts";
import {api, readableError, type ModelSyncState} from "./api";
import {contextLabel, discoveredModels, providerDraft, providerHasEdits, providerPayload, providerProtocolBaseURL, type ProviderDraft} from "./modelProviderState";
import {parseSendShortcut, type SendShortcut} from "./composerKeyboard";
import {ProviderQuickSetup,ProviderModelPicker} from "./ProviderSetup";
import {type ProviderPreset} from "./providerPresets";
import {trapSettingsTab} from './settingsFocus';
import {WorkspacePageHeader, WorkspaceSettingSection} from './WorkspacePage';
import {consoleCategoryLabel, type SettingsPage} from './workspaceConsoleTabs';
import "./modelSettings.css";
import "./externalAgents.css";
import "./gatewaySettings.css";

const formats = [["openai","OpenAI · Chat Completions"],["openai-response","OpenAI · Responses"],["claude","Anthropic · Messages"],["gemini","Gemini · Generate Content"],["azure-gpt","Azure OpenAI"],["ollama","Ollama"]];
const magpieSelection = "__magpie__";
const newProviderSelection = "__new_provider__";

function Switch({checked,label,onChange,disabled=false}: {checked:boolean;label:string;onChange:(value:boolean)=>void;disabled?:boolean}) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`provider-switch ${checked ? "on" : ""}`} disabled={disabled} onClick={() => onChange(!checked)}><span/></button>;
}
export type SettingsNavigationHandle = {confirmLeave: () => boolean | Promise<boolean>};

export function ModelSettings({tab,navigationGuard,onBusyChange,onChanged,sendShortcut,onShortcutChange,completionEnabled,onCompletionEnabledChange,onSessionConfig:openSessionConfig,projectId,capabilityDetectionEnabled=false,onGatewayTask:openGatewayTask}: {
  tab:SettingsPage;navigationGuard?:Ref<SettingsNavigationHandle>;onBusyChange:(busy:boolean)=>void;
  onChanged:()=>Promise<void>;sendShortcut:SendShortcut;onShortcutChange:(value:SendShortcut)=>void;onSessionConfig?:()=>void;projectId?:string;
  completionEnabled?:boolean;onCompletionEnabledChange?:(value:boolean)=>void;
  capabilityDetectionEnabled?:boolean;onGatewayTask?:(target:GatewayTaskTarget)=>Promise<void>;
}) {
  const [extensionBusy,setExtensionBusy]=useState(false);
  const [actionsHost,setActionsHost]=useState<HTMLDivElement|null>(null);
  const [catalog,setCatalog] = useState<ProviderCatalog>({providers:[],activeProviderId:"",activeModelId:""});
  const [magpieModel,setMagpieModel] = useState<{name:string}|null>(null);
  const [magpieModels,setMagpieModels] = useState<AvailableModels|null>(null);
  const [drafts,setDrafts] = useState<Record<string,ProviderDraft>>({});
  const [selected,setSelected] = useState("");
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState("");
  const [error,setError] = useState("");
  const [result,setResult] = useState<{ok:boolean;message:string;action?:"save"}|null>(null);
  const [editor,setEditor] = useState<ProviderModel|null>(null);
  const [discovery,setDiscovery] = useState<{id:string;available:AvailableModels}|null>(null);
  const [deleteConfirm,setDeleteConfirm] = useState(false);
  const [detection,setDetection] = useState<{id:string;status:string;total:number;complete:number}|null>(null);
  const pageRef = useRef<HTMLElement>(null);
  const providerListRef = useRef<HTMLDivElement>(null);
  const discardDialog = useRef<HTMLDialogElement>(null);
  const decision = useRef<((discard:boolean)=>void)|null>(null);
  const returnFocus = useRef<HTMLElement|null>(null);
  const lastField = useRef<HTMLElement|null>(null);
  const presetDefaults = useRef(new Map<string,ModelProvider>());
  const initialEditor = useRef<ProviderModel|null>(null);
  const editorChanged = !!editor && JSON.stringify(editor)!==JSON.stringify(initialEditor.current);
  const hasEdits = editorChanged || Object.values(drafts).some(provider=>provider.dirty);
  const presetFocus = useRef<'address'|'key'|'models'|null>(null);
  const sourceToggle = useRef<HTMLButtonElement>(null), focusSource = useRef(false);
  const addressInput = useRef<HTMLInputElement>(null), keyInput = useRef<HTMLInputElement>(null), modelsButton = useRef<HTMLButtonElement>(null);
  const [sourcesExpanded,setSourcesExpanded] = useState(false);
  const onSessionConfig=openSessionConfig && (()=>void leave(openSessionConfig));
  const onGatewayTask=openGatewayTask && ((target:GatewayTaskTarget)=>leave(()=>openGatewayTask(target)));
  const draft = drafts[selected];
  const isBusy = !!busy||extensionBusy;
  useLayoutEffect(()=>{
    onBusyChange(isBusy);
    return ()=>onBusyChange(false);
  },[isBusy,onBusyChange]);
  function confirmDiscard() {
    const prompt=discardDialog.current;
    if (!prompt || decision.current) return false;
    const active=document.activeElement as HTMLElement|null;
    returnFocus.current=!pageRef.current?.contains(active)&&lastField.current?.isConnected ? lastField.current : active;
    const answer=new Promise<boolean>(resolve=>{decision.current=resolve;});
    prompt.showModal();
    return answer;
  }
  useImperativeHandle(navigationGuard,()=>({confirmLeave:()=>isBusy ? false : !hasEdits || confirmDiscard()}));
  async function leave(action:()=>void|Promise<void>, confirm=hasEdits) {
    if (confirm && !await confirmDiscard()) return;
    await action();
  }
  function answerDiscard(discard:boolean) {
    discardDialog.current?.close();
    if (!discard && returnFocus.current?.isConnected) returnFocus.current.focus({preventScroll:true});
    decision.current?.(discard);decision.current=null;returnFocus.current=null;
  }
  useLayoutEffect(()=>{
    const target=presetFocus.current;
    if (target) ({address:addressInput,key:keyInput,models:modelsButton}[target]).current?.focus();
    else if (focusSource.current && sourceToggle.current?.getClientRects().length) sourceToggle.current.focus();
    presetFocus.current=null;focusSource.current=false;
  },[selected,sourcesExpanded]);
  useLayoutEffect(()=>{
    const list=providerListRef.current;
    if(tab!=="models"||!list)return;
    const revealSelected=()=>{
      const row=list.querySelector<HTMLButtonElement>(".provider-item.selected");
      if(row?.getClientRects().length)row.scrollIntoView({block:"nearest",inline:"nearest"});
    };
    revealSelected();
    const resize=new ResizeObserver(revealSelected);
    resize.observe(list);
    return ()=>resize.disconnect();
  },[tab,selected,sourcesExpanded,loading]);
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
    if (!capabilityDetectionEnabled || detection?.status !== "running") return;
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
  }, [capabilityDetectionEnabled,detection?.id,detection?.status]);
  useEffect(() => {
    const key = (event:KeyboardEvent) => {if(discardDialog.current?.open)trapSettingsTab(event,discardDialog.current);};
    document.addEventListener("keydown",key);
    return () => {document.removeEventListener("keydown",key);decision.current?.(false);decision.current=null;};
  }, []);
  useEffect(()=>{
    if(!hasEdits&&!isBusy)return;
    const beforeUnload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',beforeUnload);
    return ()=>window.removeEventListener('beforeunload',beforeUnload);
  },[hasEdits,isBusy]);
  function update(patch:Partial<ProviderDraft>) {
    if (["baseURL","protocol","apiKey","clearKey"].some(key => key in patch)) setDiscovery(null);
    const original=presetDefaults.current.get(selected) ?? catalog.providers.find(provider=>provider.id===selected);
    setDrafts(current=>{const next={...current[selected]!,...patch};return {...current,[selected]:{...next,dirty:!original || providerHasEdits(next,original)}};});setResult(null);
  }
  function setAllModelsEnabled(enabled: boolean) {
    if (!draft) return;
    const models = draft.models.map(model => model.enabled===enabled ? model : {...model,enabled});
    update({models});
  }
  function selectSource(id:string) {setSelected(id);setSourcesExpanded(false);setEditor(null);setDiscovery(null);setError("");setResult(null);setDeleteConfirm(false);}
  function choose(id:string) {
    const fromSourceOptions=!!document.activeElement?.closest('#model-source-options');
    if(id===selected){focusSource.current=fromSourceOptions;setSourcesExpanded(false);return;}
    void leave(()=>{focusSource.current=fromSourceOptions;selectSource(id);},editorChanged);
  }
  function addProvider(preset:ProviderPreset) {
    const id="draft-"+crypto.randomUUID();
    const fresh:ProviderDraft={...providerDraft({id,name:preset.name,baseURL:preset.baseURL,protocol:preset.protocol,enabled:true,keyConfigured:false,models:[]}),isNew:true};
    presetDefaults.current.set(id,fresh);
    presetFocus.current=!preset.baseURL?'address':preset.protocol==='ollama'?'models':'key';
    setDrafts(current => ({...current,[id]:fresh}));choose(id);
  }
  function acceptCatalog(next:ProviderCatalog,id:string) {
    presetDefaults.current.delete(selected);
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
    if (!capabilityDetectionEnabled) return saved;
    const status=await api.providerCapabilityStatus(saved.id);
    setDetection({id:saved.id,...status});
    if (status.status === "complete") await refreshDetectedProviders();
    return saved;
  }
  async function run(kind:string, action:()=>Promise<void>) {
    if (isBusy) return;setBusy(kind);setError("");setResult(null);
    try {await action();} catch(e) {setError(readableError(e));} finally {setBusy("");}
  }
  async function save() {
    await saveCurrent();
    setResult({ok:true,action:"save",message:capabilityDetectionEnabled ? "供应商已保存。图片与思考级别能力将在后台识别。" : "供应商已保存。"});
  }
  async function detectCapabilities() {
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
    presetDefaults.current.delete(selected);
    selectSource(magpieModel ? magpieSelection : next.activeProviderId || next.providers.find(provider => provider.id!==selected)?.id || Object.keys(drafts).find(id => id!==selected && drafts[id]?.isNew) || magpieSelection);
  }
  function startModel(model?:ProviderModel) {
    setDiscovery(null);
    initialEditor.current=model ? {...model} : {id:crypto.randomUUID(),name:"",displayName:"",enabled:true,contextWindow:0,supportsImageInput:false,supportsImageOutput:false,imageInputMode:"auto"};
    setEditor(initialEditor.current);setError("");
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
  return <section ref={pageRef} id="workspace-settings-page" className="workspace-page model-settings-page" aria-labelledby="model-settings-title">
    <WorkspacePageHeader id="model-settings-title" title={consoleCategoryLabel(tab) ?? '设置'}
      actions={tab==='channels' ? <div ref={setActionsHost} className="workspace-console-page-action"/> : undefined}/>
    {tab==="channels"?<GatewaySettings actionsHost={actionsHost} onBusyChange={setExtensionBusy} projectId={projectId} onTask={onGatewayTask}/>:tab==="mcp"?<MCPSettings onBusyChange={setExtensionBusy}/>:tab==="skills"?<SkillSettings onBusyChange={setExtensionBusy}/>:tab==="appearance" ? <AppearanceSettings/> : tab==="conversation" ? <section id="conversation-settings-panel" role="tabpanel" aria-labelledby="conversation-settings-tab" className="model-conversation conversation-settings">
      <WorkspaceSettingSection id="conversation-message-settings" title="消息">
        <div className="workspace-setting-card">
          <div className="workspace-setting-row">
            <div className="workspace-setting-copy">
              <strong>发送快捷键</strong>
              <p id="send-shortcut-hint" className="settings-note">{sendShortcut==='enter'?'Shift + Enter 换行。':'Enter 换行。'}输入法确认候选词时不会发送消息。</p>
            </div>
            <AppSelect label="发送快捷键" aria-describedby="send-shortcut-hint" icon={<Glyph name="return" size={15}/>}
              renderValue={sendShortcut==='enter'?'Enter 发送':'Command / Ctrl + Enter 发送'}
              value={sendShortcut} onChange={event => onShortcutChange(parseSendShortcut(event.target.value))}>
              <option value="enter">Enter 发送，Shift + Enter 换行</option>
              <option value="command-enter">Command / Ctrl + Enter 发送，Enter 换行</option>
            </AppSelect>
          </div>
          {onCompletionEnabledChange && <div className="workspace-setting-row">
            <div className="workspace-setting-copy">
              <strong>自动建议文字</strong>
              <p className="settings-note">为输入框提供起步或续写建议。按 Tab 接受，Escape 忽略。</p>
            </div>
            <Switch label="自动建议文字" checked={!!completionEnabled} onChange={onCompletionEnabledChange}/>
          </div>}
        </div>
      </WorkspaceSettingSection>
      {onSessionConfig && <WorkspaceSettingSection id="conversation-session-settings" title="会话">
        <div className="workspace-setting-card workspace-setting-row">
          <div className="workspace-setting-copy"><strong>当前会话</strong></div>
          <button type="button" className="button secondary" onClick={onSessionConfig}>当前会话配置</button>
        </div>
      </WorkspaceSettingSection>}
    </section> : <div id="model-settings-panel" role="tabpanel" aria-labelledby="model-settings-tab" className="model-settings-body">
      <WorkspaceSettingSection id="provider-sources-title" title="模型来源">
        <div className="workspace-setting-card provider-source-card">
          <div className="workspace-setting-row provider-source-bar">
            <button ref={sourceToggle} type="button" className="provider-source-toggle" aria-expanded={sourcesExpanded}
              aria-controls="model-source-options" onClick={()=>setSourcesExpanded(value=>!value)}>
              {draft && <span className="provider-avatar"><ProviderIcon name={draft.name} baseURL={draft.baseURL} size={21}/></span>}
              {selected===magpieSelection && <span className="provider-avatar magpie-avatar"><img src="/magpie.svg" alt=""/></span>}
              <span><strong>{draft?.name || (selected===magpieSelection ? 'Magpie' : loading ? '正在读取…' : '选择来源')}</strong><small>切换供应商</small></span>
              <Glyph name="chevron" size={15}/>
            </button>
            <button type="button" className="button secondary provider-add" disabled={loading || isBusy} onClick={() => choose(newProviderSelection)}>
              <Glyph name="plus" size={14}/>添加供应商
            </button>
          </div>
          <div id="model-source-options" className="provider-source-options" hidden={!sourcesExpanded}>
            <div className="provider-source-tools">
              <span>{rows.length+1} 个来源</span>
              <button type="button" className="icon-button" aria-label="刷新模型来源" title="刷新模型来源" disabled={loading || isBusy} onClick={() => void load()}><Glyph name="refresh" size={14}/></button>
            </div>
            <div ref={providerListRef} className="provider-list" aria-label="供应商列表">
              <button type="button" className={`provider-item magpie-provider-item ${selected===magpieSelection ? "selected" : ""}`}
                aria-current={selected===magpieSelection||undefined} disabled={isBusy} onClick={() => choose(magpieSelection)}>
                <span className="provider-avatar magpie-avatar"><img src="/magpie.svg" alt=""/></span>
                <span className="provider-item-copy"><strong>Magpie</strong><small>{magpieModel ? `${catalog.activeProviderId==="magpie" ? "当前使用" : "已接入"} · ${magpieModel.name}` : "未接入此 Lake 实例"}</small></span>
                <span className={`provider-state ${magpieModel ? "enabled" : ""}`} title={magpieModel ? "已接入" : "未接入"}/>
              </button>
              {loading && <p className="settings-note" role="status">正在加载…</p>}
              {rows.map(provider => <button key={provider.id} type="button" className={`provider-item ${selected===provider.id ? "selected" : ""}`}
                aria-current={selected===provider.id||undefined} disabled={isBusy} onClick={() => choose(provider.id)}>
                <span className="provider-avatar"><ProviderIcon name={provider.name} baseURL={provider.baseURL} size={21}/></span>
                <span className="provider-item-copy"><strong>{provider.name}</strong><small>{provider.isNew ? "新供应商 · 未保存" : provider.id===catalog.activeProviderId ? "当前使用" : provider.enabled ? `${provider.models.filter(model => model.enabled).length} 个模型 · 手动配置` : "已停用"}{provider.dirty && !provider.isNew ? " · 未保存" : ""}</small></span>
                <span className={`provider-state ${!provider.isNew && provider.enabled ? "enabled" : ""}`} title={provider.isNew ? "尚未保存" : provider.enabled ? "已启用" : "已停用"}/>
              </button>)}
            </div>
          </div>
        </div>
      </WorkspaceSettingSection>
      <div className="provider-detail">{selected===newProviderSelection ? <ProviderQuickSetup onSelect={addProvider}/> : selected===magpieSelection ? <>
        <WorkspaceSettingSection id="magpie-connection-title" title="Magpie 接入">
          <div className="workspace-setting-card">
            <div className="workspace-setting-row">
              <div className="workspace-setting-copy">
                <strong>接入状态</strong>
                <p className="settings-note">{magpieModel ? "在 Magpie 的 Agent 页面设置默认模型。" : "在 Magpie 的 Agent 页面安装并接入 Lake，模型目录会自动同步。"}</p>
              </div>
              <span className={magpieModel ? 'magpie-connected' : undefined}>
                {magpieModel ? catalog.activeProviderId==='magpie' ? '正在使用' : '已接入' : '未接入此 Lake 实例'}
              </span>
            </div>
            {magpieModel ? <div className="workspace-setting-row">
              <div className="workspace-setting-copy"><strong>Magpie 所选模型</strong></div>
              <span>{magpieModel.name}</span>
            </div> : <div className="workspace-setting-row">
              <div className="workspace-setting-copy"><strong>Lake Dev 联调</strong><p className="settings-note">在 Magpie 中安装插件仓库的 lake-dev.agent.js。</p></div>
            </div>}
          </div>
        </WorkspaceSettingSection>
        {magpieModel && <MagpieModelList available={magpieModels} busy={isBusy} onSelect={modelId => void run("select",() => activateMagpie(modelId))}/>}
      </> : draft ? <fieldset disabled={isBusy} className="provider-fields" onFocusCapture={event=>{lastField.current=event.target;}}>
        <WorkspaceSettingSection id="provider-configuration-title" title="供应商配置" actions={
          <button type="button" className="provider-text-button danger-text" disabled={isBusy} onClick={() => draft.isNew ? void leave(()=>run("delete",remove),draft.dirty || editorChanged) : setDeleteConfirm(true)}>{draft.isNew ? "移除草稿" : "删除供应商"}</button>
        }>
        <div className="provider-connection-group workspace-setting-card">
          <div className="workspace-setting-row">
            <div className="workspace-setting-copy"><strong>启用供应商</strong><p className="settings-note">{draft.dirty ? "有未保存的更改" : draft.isNew ? "待配置 · 未保存" : "已保存"}</p></div>
            <Switch label="启用供应商" checked={draft.enabled} disabled={isBusy} onChange={enabled => update({enabled})}/>
          </div>
          <div className="workspace-setting-row">
            <div className="workspace-setting-copy"><label htmlFor="provider-name">供应商名称</label></div>
            <input className="workspace-setting-field" id="provider-name" maxLength={120} value={draft.name} onChange={event => update({name:event.target.value})}/>
          </div>
          <div className="workspace-setting-row">
            <div className="workspace-setting-copy"><label htmlFor="provider-address">Base URL</label></div>
            <input className="workspace-setting-field" id="provider-address" ref={addressInput} spellCheck={false} autoComplete="off" maxLength={2000} placeholder="https://api.example.com/v1" value={draft.baseURL} onChange={event => update({baseURL:event.target.value})}/>
          </div>
          <div className="workspace-setting-row">
            <div className="workspace-setting-copy"><strong>API 格式</strong></div>
            <AppSelect label="API 格式" icon={<Glyph name="code" size={15}/>} value={draft.protocol} disabled={isBusy} title={formats.find(([id])=>id===draft.protocol)?.[1]} onChange={event => update({protocol:event.target.value,baseURL:providerProtocolBaseURL(draft.baseURL,event.target.value)})}>
              {formats.map(([id,label]) => <option key={id} value={id}>{label}</option>)}
            </AppSelect>
          </div>
          <div className="workspace-setting-row">
            <div className="workspace-setting-copy"><label htmlFor="provider-key">API Key</label></div>
            <div className="provider-key-row workspace-setting-field">
              <input id="provider-key" ref={keyInput} type="password" autoComplete="new-password" spellCheck={false} maxLength={4096} placeholder={draft.clearKey ? "保存后清除密钥" : draft.keyConfigured ? "已保存密钥，留空保持不变" : "输入密钥；本地模型可留空"} value={draft.apiKey} onChange={event => update({apiKey:event.target.value,clearKey:false})}/>
              {draft.keyConfigured && <button type="button" className="provider-text-button" onClick={() => update({clearKey:!draft.clearKey,apiKey:""})}>{draft.clearKey ? "撤销清除" : "清除"}</button>}
            </div>
          </div>
          {deleteConfirm && <div className="workspace-setting-row" role="group" aria-label="确认删除供应商">
            <div className="workspace-setting-copy">删除「{draft.name}」及其模型？</div>
            <div className="workspace-setting-actions">
              <button type="button" className="provider-text-button" disabled={isBusy} onClick={() => setDeleteConfirm(false)}>取消</button>
              <button type="button" className="provider-text-button danger-text" disabled={isBusy} onClick={() => void run("delete",remove)}>确认删除</button>
            </div>
          </div>}
        </div>
        </WorkspaceSettingSection>
        <WorkspaceSettingSection id="provider-models-title" title="模型列表" actions={<>
            <span className="workspace-directory-count">{draft.models.length} 个</span>
            {draft.models.length>0 && <div className="workspace-setting-actions" role="group" aria-label="批量设置模型状态">
              <button type="button" className="button secondary" disabled={!!editor || !!discovery || !draft.models.some(model => !model.enabled)} onClick={() => setAllModelsEnabled(true)}><Glyph name="check" size={14}/>全部启用</button>
              <button type="button" className="button secondary" disabled={!!editor || !!discovery || !draft.models.some(model => model.enabled)} onClick={() => setAllModelsEnabled(false)}><Glyph name="close" size={14}/>全部停用</button>
            </div>}
            {capabilityDetectionEnabled && <button type="button" className="provider-text-button" disabled={draft.isNew || draft.dirty || !!editor || !!discovery} onClick={() => void run("detect-capabilities",detectCapabilities)}>重新识别模型能力</button>}
            <button ref={modelsButton} type="button" className="provider-text-button" disabled={!draft.baseURL.trim() || !!editor || !!discovery} onClick={() => void run("discover",discover)}>{busy==="discover" ? "获取中…" : "从 API 选择模型"}</button>
            <button type="button" className="provider-text-button" disabled={!!editor || !!discovery} onClick={() => startModel()}><Glyph name="plus" size={13}/>手动添加</button>
        </>}>
        {capabilityDetectionEnabled && detection?.id===draft.id && detection.status==="running" && <p className="settings-note" role="status">模型能力后台识别中：{detection.complete}/{detection.total}</p>}
        {((!editor && !discovery) || draft.models.length>0) && <div className="provider-model-list workspace-setting-card">{!draft.models.length && !editor && <div className="provider-model-empty">从 API 选择需要的模型，也可以手动添加模型 ID。</div>}{draft.models.map(model => <div className="provider-model-row" key={model.id}><div className="provider-model-name"><strong title={model.name}>{model.displayName || model.name}</strong>{model.displayName && <small>{model.name}</small>}</div><span className="provider-context" title="上下文窗口">{contextLabel(model.contextWindow)}</span><button type="button" className={`provider-use ${catalog.activeProviderId===draft.id && catalog.activeModelId===model.id ? "active" : ""}`} aria-label={`使用模型 ${model.name}`} title="用于聊天" disabled={!draft.enabled || !model.enabled || !!editor || !!discovery} onClick={() => void run("select",() => activate(model.id))}>{catalog.activeProviderId===draft.id && catalog.activeModelId===model.id ? "使用中" : "使用"}</button><button className="provider-row-icon" aria-label={`编辑模型 ${model.name}`} disabled={!!editor} onClick={() => startModel(model)}><Glyph name="edit" size={14}/></button><button className="provider-row-icon" aria-label={`删除模型 ${model.name}`} disabled={!!editor} onClick={() => update({models:draft.models.filter(item => item.id!==model.id)})}><Glyph name="trash" size={14}/></button><Switch label={`启用模型 ${model.name}`} checked={model.enabled} onChange={enabled => update({models:draft.models.map(item => item.id===model.id ? {...item,enabled} : item)})}/></div>)}</div>}
        {discovery && <ProviderModelPicker key={discovery.id} available={discovery.available} current={draft.models} onAdd={addDiscoveredModels} onCancel={() => setDiscovery(null)}/>}
        {editor && <ProviderModelEditor model={editor} editing={draft.models.some(model => model.id===editor.id)} onChange={setEditor} onCancel={() => {setEditor(null);setError("");}} onCommit={commitModel}/>}
        </WorkspaceSettingSection>
      </fieldset> : <WorkspaceSettingSection id="provider-get-started-title" title="供应商配置">
        <div className="workspace-setting-card workspace-setting-row">
          <div className="workspace-setting-copy"><strong>添加模型供应商</strong><p className="settings-note">同一供应商可配置多个模型，聊天时直接切换。</p></div>
          <button className="button primary" disabled={loading || isBusy} onClick={() => choose(newProviderSelection)}>添加供应商</button>
        </div>
      </WorkspaceSettingSection>}</div>
    </div>}
    {tab==="models"&&<footer className="workbench-dialog-footer model-settings-footer"><div className="provider-feedback" aria-live="polite">{error ? <p className="form-error" role="alert">{error}</p> : result ? <p className={result.ok ? "provider-success" : "form-error"}>{result.message}</p> : <p>{selected===magpieSelection ? magpieModel ? "Magpie 与手动供应商的模型可随时切换。" : "接入后会自动同步 Magpie 模型。" : discovery ? "勾选模型并添加到列表后，保存供应商使配置生效。" : selected===newProviderSelection ? "厂商预设会自动填写接入地址和 API 格式。" : editor ? "完成模型编辑后，保存供应商使配置生效。" : magpieModel ? "保存后点击「使用」即可切换模型，无需停用 Magpie 接入。" : "每个供应商独立保存密钥。保存后立即生效。"}</p>}</div>{draft && <div className="provider-footer-actions"><button className="button secondary" disabled={isBusy || !draft.baseURL.trim() || !draft.models.length || !!editor || !!discovery} onClick={() => void run("test",test)}>{busy==="test" ? "测试中…" : "测试连接"}</button><SaveAction label="保存供应商" saving={busy==="save"} saved={result?.action==="save"} disabled={isBusy || !draft.baseURL.trim() || !draft.name.trim() || !!editor || !!discovery || (!draft.dirty && !draft.isNew)} onClick={() => void run("save",save)}/></div>}</footer>}
    <dialog ref={discardDialog} className="presentation-dialog provider-discard-dialog" role="alertdialog" aria-modal="true" aria-labelledby="provider-discard-title" aria-describedby="provider-discard-hint" onCancel={event=>{event.preventDefault();answerDiscard(false);}}>
      <h3 id="provider-discard-title">放弃未保存的更改？</h3><p id="provider-discard-hint">选择「继续编辑」可保留刚才的输入。</p>
      <div className="provider-editor-actions"><button type="button" className="button secondary" onClick={()=>answerDiscard(false)}>继续编辑</button><button type="button" className="button danger" onClick={()=>answerDiscard(true)}>放弃更改</button></div>
    </dialog>
  </section>;
}

function ProviderModelEditor({model,editing,onChange,onCancel,onCommit}: {
  model:ProviderModel;editing:boolean;onChange:(model:ProviderModel)=>void;onCancel:()=>void;onCommit:()=>void;
}) {
  const editorRef=useRef<HTMLDivElement>(null);
  useEffect(() => {editorRef.current?.scrollIntoView({block:"nearest"});}, []);
  return <div ref={editorRef} className="provider-model-editor workspace-setting-card" role="group" aria-labelledby="provider-model-editor-title">
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
  return <WorkspaceSettingSection id="magpie-models-title" title="可用模型" actions={<span className="workspace-directory-count">{available?.entries?.length || 0} 个</span>}>
    <label className="visually-hidden" htmlFor="magpie-model-search">搜索 Magpie 模型</label>
    <input id="magpie-model-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索模型"/>
    <div className="provider-model-list magpie-model-list workspace-setting-card" role="region" aria-labelledby="magpie-models-title" tabIndex={0}>
      {entries.length ? entries.map(entry => <div className="provider-model-row" key={entry.modelId}>
        <div className="provider-model-name"><strong title={entry.name}>{entry.displayName}</strong>{entry.displayName!==entry.name && <small>{entry.name}</small>}</div>
        <span className="provider-context" title="上下文窗口">{contextLabel(entry.contextWindow)}</span>
        <button type="button" className={`provider-use ${entry.modelId===available?.activeModelId ? "active" : ""}`} disabled={busy || entry.modelId===available?.activeModelId} aria-label={`使用 Magpie 模型 ${entry.name}`} onClick={() => onSelect(entry.modelId)}>{entry.modelId===available?.activeModelId ? "使用中" : "使用"}</button>
      </div>) : <div className="provider-model-empty">{query ? "没有匹配的模型" : "Magpie 尚未提供模型目录，请更新 Lake 插件后在 Magpie 中刷新接入。"}</div>}
    </div>
  </WorkspaceSettingSection>;
}

function AppearanceSettings() {
  const [preference, setPreference] = useState<ThemePreference>(themePreference);
  return <section id="appearance-settings-panel" role="tabpanel" aria-labelledby="appearance-settings-tab" className="model-conversation">
    <WorkspaceSettingSection id="appearance-theme-title" title="工作台主题">
      <div className="theme-options workspace-setting-card" role="radiogroup" aria-labelledby="appearance-theme-title">{([['light','浅色'],['dark','深色'],['system','跟随系统']] as const).map(([value,label]) => <button key={value} type="button" role="radio" aria-checked={preference===value} className="theme-choice" tabIndex={preference===value ? 0 : -1} onKeyDown={event => { if (!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key)) return; event.preventDefault(); const values:ThemePreference[]=["light","dark","system"]; const next=values[(values.indexOf(value)+(event.key==="ArrowLeft"||event.key==="ArrowUp"?2:1))%3]!; setPreference(next); setThemePreference(next); const buttons=event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button"); buttons?.[values.indexOf(next)]?.focus(); }} onClick={() => { setPreference(value); setThemePreference(value); }}><span className="theme-preview" data-preview={value} aria-hidden="true"><i/><span/></span><strong>{label}</strong>{preference===value&&<Glyph name="check" size={16}/>}</button>)}</div>
    </WorkspaceSettingSection>
  </section>;
}
