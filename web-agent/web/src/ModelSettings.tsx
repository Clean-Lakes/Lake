import {useEffect, useRef, useState} from "react";
import type {ModelProvider, ProviderCatalog, ProviderModel} from "../../shared/contracts";
import {api, readableError} from "./api";
import {contextLabel, discoveredModels, providerDraft, providerPayload, type ProviderDraft} from "./modelProviderState";
import {parseSendShortcut, type SendShortcut} from "./composerKeyboard";
import "./modelSettings.css";

const formats = [["openai","OpenAI Chat Completions (/v1/chat/completions)"],["openai-response","OpenAI Responses (/v1/responses)"],["claude","Anthropic Messages (/v1/messages)"],["gemini","Gemini Generate Content"],["azure-gpt","Azure OpenAI"],["ollama","Ollama (/api/chat)"]];
const templates = [
  {name:"自定义供应商",baseURL:"",protocol:"openai"},
  {name:"DeepSeek",baseURL:"https://api.deepseek.com/v1",protocol:"openai"},
  {name:"OpenAI",baseURL:"https://api.openai.com/v1",protocol:"openai"},
  {name:"Anthropic",baseURL:"https://api.anthropic.com/v1",protocol:"claude"},
  {name:"通义千问",baseURL:"https://dashscope.aliyuncs.com/compatible-mode/v1",protocol:"openai"},
  {name:"智谱 GLM",baseURL:"https://open.bigmodel.cn/api/paas/v4",protocol:"openai"},
  {name:"本地 Ollama",baseURL:"http://127.0.0.1:11434",protocol:"ollama"},
];
function Switch({checked,label,onChange,disabled=false}: {checked:boolean;label:string;onChange:(value:boolean)=>void;disabled?:boolean}) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`provider-switch ${checked ? "on" : ""}`} disabled={disabled} onClick={() => onChange(!checked)}><span/></button>;
}
export function ModelSettings({onClose,onChanged,sendShortcut,onShortcutChange,onSessionConfig,ignoreProjectMemory,onIgnoreProjectMemoryChange}: {
  onClose:()=>void;onChanged:()=>Promise<void>;sendShortcut:SendShortcut;onShortcutChange:(value:SendShortcut)=>void;onSessionConfig?:()=>void;
  ignoreProjectMemory:boolean;onIgnoreProjectMemoryChange:(value:boolean)=>void;
}) {
  const [tab,setTab] = useState("models");
  const [catalog,setCatalog] = useState<ProviderCatalog>({providers:[],activeProviderId:"",activeModelId:""});
  const [drafts,setDrafts] = useState<Record<string,ProviderDraft>>({});
  const [selected,setSelected] = useState("");
  const [loading,setLoading] = useState(true);
  const [busy,setBusy] = useState("");
  const [error,setError] = useState("");
  const [result,setResult] = useState<{ok:boolean;message:string}|null>(null);
  const [editor,setEditor] = useState<ProviderModel|null>(null);
  const [deleteConfirm,setDeleteConfirm] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef=useRef(onClose);closeRef.current=onClose;
  const busyRef=useRef(busy);busyRef.current=busy;
  const draft = drafts[selected];
  const isBusy = !!busy;
  async function load() {
    setLoading(true);setError("");
    try {
      const next = await api.providers();setCatalog(next);
      setDrafts(current => Object.fromEntries([...Object.entries(current).filter(([,value]) => value.isNew), ...next.providers.map(provider => [provider.id,current[provider.id]?.dirty ? current[provider.id] : providerDraft(provider)])]));
      setSelected(current => current || next.activeProviderId || next.providers[0]?.id || "");
    } catch (e) {setError(readableError(e));} finally {setLoading(false);}
  }
  useEffect(() => {void load();}, []);
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
    setDrafts(current => ({...current,[selected]:{...current[selected]!,...patch,dirty:true}}));setResult(null);
  }
  function choose(id:string) {setSelected(id);setEditor(null);setError("");setResult(null);setDeleteConfirm(false);}
  function addProvider() {
    const id="draft-"+crypto.randomUUID();
    const fresh:ProviderDraft={...providerDraft({id,name:"自定义供应商",baseURL:"",protocol:"openai",enabled:true,keyConfigured:false,models:[]}),isNew:true,dirty:true};
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
    if (!draft.dirty && !draft.isNew) return draft;
    const next=await api.saveProvider(draft.isNew ? null : draft.id,providerPayload(draft));
    const saved=next.providers.find(provider => provider.id===next.savedProviderId)!;
    acceptCatalog(next,saved.id);await onChanged();return saved;
  }
  async function run(kind:string, action:()=>Promise<void>) {
    if (isBusy) return;setBusy(kind);setError("");setResult(null);
    try {await action();} catch(e) {setError(readableError(e));} finally {setBusy("");}
  }
  async function save() {await saveCurrent();setResult({ok:true,message:"供应商已保存，聊天中可直接选择模型。"});}
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
    const models=discoveredModels(draft!.models,found.models);
    update({models});setResult({ok:true,message:`获取 ${found.models.length} 个模型，新增 ${models.length-draft!.models.length} 个；保存后生效。${found.message ? " "+found.message : ""}`});
  }
  async function activate(modelId:string) {
    const saved=await saveCurrent();
    const next=await api.selectProviderModel(saved.id,modelId);setCatalog(next);await onChanged();setResult({ok:true,message:"已切换当前聊天模型。"});
  }
  async function remove() {
    if (!draft) return;
    let next=catalog;
    if (!draft.isNew) {next=await api.deleteProvider(draft.id);setCatalog(next);await onChanged();}
    setDrafts(current => {const remaining={...current};delete remaining[selected];return remaining;});
    choose(next.providers.find(provider => provider.id!==selected)?.id || Object.keys(drafts).find(id => id!==selected && drafts[id]?.isNew) || "");
  }
  function startModel(model?:ProviderModel) {
    setEditor(model ? {...model} : {id:crypto.randomUUID(),name:"",displayName:"",enabled:true,contextWindow:0,supportsImageInput:false,supportsImageOutput:false});setError("");
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
    <header className="model-settings-header"><div><h2 id="model-settings-title">{tab==="models" ? "模型设置" : "对话设置"}</h2><p>配置供应商与模型，在聊天中随时切换。</p></div><button className="icon-button" aria-label="关闭设置" disabled={isBusy} onClick={onClose}>×</button></header>
    <div className="model-settings-tabs" role="tablist" aria-label="设置分类"><button role="tab" id="model-settings-tab" aria-controls="model-settings-panel" aria-selected={tab==="models"} onClick={() => setTab("models")}>模型</button><button role="tab" id="conversation-settings-tab" aria-controls="conversation-settings-panel" aria-selected={tab==="conversation"} onClick={() => setTab("conversation")}>对话</button></div>
    {tab==="conversation" ? <section id="conversation-settings-panel" role="tabpanel" aria-labelledby="conversation-settings-tab" className="model-conversation"><label className="field-label">发送快捷键<select value={sendShortcut} onChange={event => onShortcutChange(parseSendShortcut(event.target.value))}><option value="enter">Enter 发送，Shift + Enter 换行</option><option value="command-enter">Command / Ctrl + Enter 发送，Enter 换行</option></select></label><p className="settings-note">立即生效并自动保存。输入法确认候选词时不会发送消息。</p>{onSessionConfig && <div className="model-conversation-memory"><h3>当前会话</h3><label><input type="checkbox" checked={ignoreProjectMemory} onChange={event => onIgnoreProjectMemoryChange(event.target.checked)}/>本轮忽略项目记忆</label><p className="settings-note">仅对下一条消息生效，发送后自动取消。</p><button className="button secondary" onClick={onSessionConfig}>当前会话配置</button></div>}</section> : <div id="model-settings-panel" role="tabpanel" aria-labelledby="model-settings-tab" className="model-settings-body">
      <aside className="provider-rail"><div className="provider-rail-title"><span>供应商 <small>{rows.length}</small></span><button className="icon-button" aria-label="刷新供应商" title="刷新供应商" disabled={loading || isBusy} onClick={() => void load()}>↻</button></div><button className="provider-add" disabled={loading || isBusy} onClick={addProvider}>＋ 添加供应商</button><div className="provider-list" aria-label="供应商列表">
        {loading && <p className="settings-note">正在加载…</p>}{rows.map(provider => <button key={provider.id} className={`provider-item ${selected===provider.id ? "selected" : ""}`} disabled={isBusy} onClick={() => choose(provider.id)}><span className="provider-avatar">{provider.name.charAt(0) || "◇"}</span><span className="provider-item-copy"><strong>{provider.name}</strong><small>{provider.isNew ? "新供应商" : provider.id===catalog.activeProviderId ? "当前使用" : provider.enabled ? `${provider.models.filter(model => model.enabled).length} 个模型` : "已停用"}{provider.dirty ? " · 未保存" : ""}</small></span><span className={`provider-state ${provider.enabled ? "enabled" : ""}`} title={provider.enabled ? "已启用" : "已停用"}/></button>)}</div></aside>
      <section className="provider-detail" aria-label="供应商配置">{draft ? <>
        <div className="provider-detail-heading"><div><h3>{draft.name || "新供应商"}</h3><span>{draft.dirty ? "有未保存的更改" : "已保存"}</span></div><Switch label="启用供应商" checked={draft.enabled} disabled={isBusy} onChange={enabled => update({enabled})}/></div>
        <fieldset disabled={isBusy} className="provider-fields">
        {draft.isNew && <label className="field-label">配置模板<select key={draft.id} defaultValue="0" onChange={event => {const preset=templates[Number(event.target.value)]!;update({...preset});}}>{templates.map((preset,index) => <option key={index} value={index}>{preset.name}</option>)}</select></label>}
        <label className="field-label">供应商名称<input maxLength={120} value={draft.name} onChange={event => update({name:event.target.value})}/></label>
        <label className="field-label">Base URL<input spellCheck={false} autoComplete="off" maxLength={2000} placeholder="https://api.example.com/v1" value={draft.baseURL} onChange={event => update({baseURL:event.target.value})}/></label>
        <label className="field-label">API 格式<select value={draft.protocol} onChange={event => update({protocol:event.target.value})}>{formats.map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label className="field-label">API Key<div className="provider-key-row"><input type="password" autoComplete="new-password" spellCheck={false} maxLength={4096} placeholder={draft.clearKey ? "保存后清除密钥" : draft.keyConfigured ? "已保存密钥，留空保持不变" : "输入密钥；本地模型可留空"} value={draft.apiKey} onChange={event => update({apiKey:event.target.value,clearKey:false})}/>{draft.keyConfigured && <button type="button" className="provider-text-button" onClick={() => update({clearKey:!draft.clearKey,apiKey:""})}>{draft.clearKey ? "撤销清除" : "清除"}</button>}</div></label>
        <div className="provider-model-heading"><h4>模型列表 <small>{draft.models.length}</small></h4><div><button type="button" className="provider-text-button" disabled={!draft.baseURL.trim() || !!editor} onClick={() => void run("discover",discover)}>从接口获取</button><button type="button" className="provider-text-button" disabled={!!editor} onClick={() => startModel()}>＋ 添加模型</button></div></div>
        <div className="provider-model-list">{!draft.models.length && !editor && <div className="provider-model-empty">添加模型 ID，或从接口获取模型列表。</div>}{draft.models.map(model => <div className="provider-model-row" key={model.id}><div className="provider-model-name"><strong title={model.name}>{model.displayName || model.name}</strong>{model.displayName && <small>{model.name}</small>}</div><span className="provider-context" title="上下文窗口">{contextLabel(model.contextWindow)}</span><button type="button" className={`provider-use ${catalog.activeProviderId===draft.id && catalog.activeModelId===model.id ? "active" : ""}`} aria-label={`使用模型 ${model.name}`} title="用于聊天" disabled={!draft.enabled || !model.enabled || !!editor} onClick={() => void run("select",() => activate(model.id))}>{catalog.activeProviderId===draft.id && catalog.activeModelId===model.id ? "使用中" : "使用"}</button><button className="provider-row-icon" aria-label={`编辑模型 ${model.name}`} disabled={!!editor} onClick={() => startModel(model)}>✎</button><button className="provider-row-icon" aria-label={`删除模型 ${model.name}`} disabled={!!editor} onClick={() => update({models:draft.models.filter(item => item.id!==model.id)})}>×</button><Switch label={`启用模型 ${model.name}`} checked={model.enabled} onChange={enabled => update({models:draft.models.map(item => item.id===model.id ? {...item,enabled} : item)})}/></div>)}</div>
        {editor && <div className="provider-model-editor"><label className="field-label">模型 ID<input autoFocus maxLength={200} placeholder="例如 mimo-v2.6-pro" value={editor.name} onChange={event => setEditor({...editor,name:event.target.value})}/></label><div className="provider-model-editor-grid"><label className="field-label">显示名称（可选）<input maxLength={120} value={editor.displayName || ""} onChange={event => setEditor({...editor,displayName:event.target.value})}/></label><label className="field-label">上下文 tokens（可选）<input type="number" min={2048} max={2000000} step={1} placeholder="自动检测" value={editor.contextWindow || ""} onChange={event => setEditor({...editor,contextWindow:event.target.value ? Number(event.target.value) : 0})}/></label></div><div className="provider-capabilities"><label><input type="checkbox" checked={editor.supportsImageInput} onChange={event => setEditor({...editor,supportsImageInput:event.target.checked})}/>图片输入</label><label><input type="checkbox" checked={editor.supportsImageOutput} onChange={event => setEditor({...editor,supportsImageOutput:event.target.checked})}/>图片输出</label></div><div className="provider-editor-actions"><button className="provider-text-button" onClick={() => {setEditor(null);setError("");}}>取消</button><button className="button secondary" onClick={commitModel}>完成模型编辑</button></div></div>}
        </fieldset>
        <div className="provider-delete">{deleteConfirm ? <><span>删除此供应商及其模型？</span><button className="provider-text-button" disabled={isBusy} onClick={() => setDeleteConfirm(false)}>取消</button><button className="provider-text-button danger-text" disabled={isBusy} onClick={() => void run("delete",remove)}>确认删除</button></> : <button className="provider-text-button danger-text" disabled={isBusy} onClick={() => draft.isNew ? void run("delete",remove) : setDeleteConfirm(true)}>{draft.isNew ? "移除草稿" : "删除供应商"}</button>}</div>
      </> : <div className="provider-empty"><span>◇</span><h3>添加你的模型供应商</h3><p>同一供应商可配置多个模型，聊天时直接切换。</p><button className="button primary" disabled={loading || isBusy} onClick={addProvider}>＋ 添加供应商</button></div>}</section>
    </div>}
    <footer className="model-settings-footer"><div className="provider-feedback" aria-live="polite">{error ? <p className="form-error" role="alert">{error}</p> : result ? <p className={result.ok ? "provider-success" : "form-error"}>{result.message}</p> : <p>{tab==="models" ? "每个供应商独立保存密钥。保存后立即生效。" : "对话偏好自动保存。"}</p>}</div>{tab==="models" && draft && <div className="provider-footer-actions"><button className="button secondary" disabled={isBusy || !draft.baseURL.trim() || !draft.models.length || !!editor} onClick={() => void run("test",test)}>{busy==="test" ? "测试中…" : "测试连接"}</button><button className="button primary" disabled={isBusy || !draft.baseURL.trim() || !draft.name.trim() || !!editor || !draft.dirty} onClick={() => void run("save",save)}>{busy==="save" ? "保存中…" : "保存供应商"}</button></div>}</footer>
  </div></div>;
}
