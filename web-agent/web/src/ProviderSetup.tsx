import {ProviderIcon} from "./ProviderIcon";
import {Glyph} from "./Icons";
import {useEffect,useRef,useState} from "react";
import type {AvailableModels,ProviderModel} from "../../shared/contracts";
import {customProviderPreset,providerPresets,type ProviderPreset} from "./providerPresets";
import {WorkspaceSettingSection} from "./WorkspacePage";

export function ProviderQuickSetup({onSelect}: {onSelect:(preset:ProviderPreset)=>void}) {
  const [query,setQuery]=useState("");
  const presets=providerPresets.filter(preset => `${preset.name} ${preset.subtitle} ${preset.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <WorkspaceSettingSection id="provider-setup-title" title="添加模型供应商">
    <input className="provider-setup-search" aria-label="搜索模型厂商" placeholder="搜索厂商，例如 DeepSeek、Kimi…" value={query} onChange={event => setQuery(event.target.value)}/>
    <div className="provider-setup-list workspace-setting-card">
      {presets.map(preset => <button type="button" className="provider-setup-row" key={preset.id} onClick={() => onSelect(preset)}>
        <span className="provider-preset-mark" aria-hidden="true"><ProviderIcon brand={preset.id}/></span>
        <span className="provider-item-copy"><strong>{preset.name}</strong><small>{preset.subtitle}</small></span>
        <Glyph name="next" size={14}/>
      </button>)}
      {!presets.length && <p className="workspace-setting-row settings-note">没有匹配的厂商，可以使用自定义 API。</p>}
      <button type="button" className="provider-setup-row" onClick={() => onSelect(customProviderPreset)}>
        <span className="provider-preset-mark" aria-hidden="true"><ProviderIcon brand="custom"/></span>
        <span className="provider-item-copy"><strong>自定义 API</strong><small>支持兼容接口、代理服务和私有部署</small></span>
        <Glyph name="next" size={14}/>
      </button>
    </div>
    <p className="settings-note">选择供应商后，填写对应厂商和区域的 API Key，再获取需要的模型。</p>
  </WorkspaceSettingSection>;
}

export function ProviderModelPicker({available,current,onAdd,onCancel}: {available:AvailableModels;current:ProviderModel[];onAdd:(names:string[])=>void;onCancel:()=>void}) {
  const [query,setQuery]=useState("");
  const [selected,setSelected]=useState<Set<string>>(() => new Set());
  const pickerRef=useRef<HTMLDivElement>(null);
  useEffect(() => {
    const picker=pickerRef.current;
    const panel=picker?.closest(".provider-detail");
    // Keep the search and confirmation controls together when the card fits.
    // Taller cards on small windows retain the user's normal scroll position.
    if (picker && panel && picker.offsetHeight<=panel.clientHeight) picker.scrollIntoView({block:"nearest"});
  }, [query,selected.size]);
  const existing=new Set(current.map(model => model.name));
  const names=[...new Set(available.models.filter(name => name.trim() && name.length<=200 && !/[\r\n\0]/.test(name)))];
  const visible=names.filter(name => name.toLowerCase().includes(query.trim().toLowerCase()));
  const selectable=visible.filter(name => !existing.has(name));
  const allVisibleSelected=selectable.length>0 && selectable.every(name => selected.has(name));
  const remaining=Math.max(0,256-current.length);
  function toggle(name:string) {setSelected(previous => {const next=new Set(previous);if (next.has(name)) next.delete(name);else next.add(name);return next;});}
  function selectVisible() {setSelected(previous => new Set([...previous,...selectable]));}
  return <div ref={pickerRef} className="provider-discovery workspace-setting-card" role="group" aria-labelledby="provider-discovery-title">
    <div className="provider-discovery-heading"><div><h4 id="provider-discovery-title">从 API 添加模型</h4><p>获取到 {names.length} 个模型，勾选需要添加的模型。</p></div><button type="button" className="provider-text-button" onClick={onCancel}>关闭</button></div>
    <input aria-label="搜索 API 模型" placeholder="搜索模型 ID…" value={query} onChange={event => setQuery(event.target.value)}/>
    <div className="provider-discovery-toolbar">
      <div className="provider-discovery-selection">
        <button type="button" className="button secondary" disabled={!selectable.length || allVisibleSelected} onClick={selectVisible}><Glyph name="check" size={14}/>全选当前结果</button>
        <button type="button" className="button secondary" disabled={!selected.size} title="取消所有待添加模型的勾选" onClick={() => setSelected(new Set())}><Glyph name="close" size={14}/>全部取消</button>
      </div>
      <span aria-live="polite">已选 {selected.size} 个</span>
    </div>
    <div className="provider-discovery-list" role="region" aria-label="API 返回的模型" tabIndex={0}>
      {visible.map(name => existing.has(name) ? (
        <div className="provider-discovery-row already-added" key={name}><span title={name}>{name}</span><small>已添加</small></div>
      ) : (
        <label className="provider-discovery-row" key={name}><input type="checkbox" checked={selected.has(name)} onChange={() => toggle(name)}/><span title={name}>{name}</span></label>
      ))}
      {!visible.length && <div className="provider-model-empty">没有匹配的模型，试试其他关键词。</div>}
    </div>
    {available.message && <p className="provider-discovery-note">{available.message}</p>}
    {selected.size>remaining && <p className="form-error" role="alert">每个供应商最多 256 个模型，还可添加 {remaining} 个，请减少选择。</p>}
    <div className="provider-discovery-actions"><span>添加后保存供应商生效</span><button type="button" className="button primary" disabled={!selected.size || selected.size>remaining} onClick={() => onAdd(names.filter(name => selected.has(name) && !existing.has(name)))}>添加所选模型{selected.size>0 ? `（${selected.size}）` : ""}</button></div>
  </div>;
}
