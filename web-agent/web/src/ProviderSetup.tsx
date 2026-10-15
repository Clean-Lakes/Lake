import {ProviderIcon} from "./ProviderIcon";
import {Glyph} from "./Icons";
import {useEffect,useRef,useState} from "react";
import type {AvailableModels,ProviderModel} from "../../shared/contracts";
import {customProviderPreset,providerPresets,type ProviderPreset} from "./providerPresets";

export function ProviderQuickSetup({onSelect}: {onSelect:(preset:ProviderPreset)=>void}) {
  const [query,setQuery]=useState("");
  const presets=providerPresets.filter(preset => `${preset.name} ${preset.subtitle} ${preset.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="provider-quick-setup">
    <div className="provider-setup-heading"><h3>添加模型供应商</h3><p>选择厂商后填写 API Key，再获取并勾选需要的模型。</p></div>
    <input aria-label="搜索模型厂商" placeholder="搜索厂商，例如 DeepSeek、Kimi…" value={query} onChange={event => setQuery(event.target.value)}/>
    <div className="provider-preset-grid" aria-label="快速接入厂商">{presets.map(preset => <button type="button" className="provider-preset-card" key={preset.id} onClick={() => onSelect(preset)}><span className="provider-preset-mark" aria-hidden="true"><ProviderIcon brand={preset.id}/></span><span><strong>{preset.name}</strong><small>{preset.subtitle}</small></span></button>)}</div>
    {!presets.length && <p className="settings-note">没有匹配的厂商，可以使用自定义 API。</p>}
    <button type="button" className="provider-custom-card" onClick={() => onSelect(customProviderPreset)}><span className="provider-preset-mark" aria-hidden="true"><ProviderIcon brand="custom"/></span><span><strong>自定义 API</strong><small>支持兼容接口、代理服务和私有部署</small></span><span aria-hidden="true"><Glyph name="arrow" size={16}/></span></button>
    <p className="provider-setup-note">使用对应厂商和区域的密钥；接入地址和 API 格式都可以继续修改。</p>
  </div>;
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
  function toggleVisible() {setSelected(previous => {const next=new Set(previous);for (const name of selectable) if (allVisibleSelected) next.delete(name);else next.add(name);return next;});}
  return <div ref={pickerRef} className="provider-discovery" role="group" aria-labelledby="provider-discovery-title">
    <div className="provider-discovery-heading"><div><h4 id="provider-discovery-title">从 API 添加模型</h4><p>获取到 {names.length} 个模型，勾选需要添加的模型。</p></div><button type="button" className="provider-text-button" onClick={onCancel}>关闭</button></div>
    <input aria-label="搜索 API 模型" placeholder="搜索模型 ID…" value={query} onChange={event => setQuery(event.target.value)}/>
    <div className="provider-discovery-toolbar"><button type="button" className="provider-text-button" disabled={!selectable.length} onClick={toggleVisible}>{allVisibleSelected ? "取消选择当前结果" : "选择当前结果"}</button><span>已选 {selected.size} 个</span>{selected.size>0 && <button type="button" className="provider-text-button" onClick={() => setSelected(new Set())}>清空选择</button>}</div>
    <div className="provider-discovery-list" role="region" aria-label="API 返回的模型" tabIndex={0}>{visible.map(name => {const added=existing.has(name);return <label className={`provider-discovery-row ${added ? "already-added" : ""}`} key={name}><input type="checkbox" checked={added || selected.has(name)} disabled={added} onChange={() => toggle(name)}/><span title={name}>{name}</span>{added && <small>已添加</small>}</label>;})}{!visible.length && <div className="provider-model-empty">没有匹配的模型，试试其他关键词。</div>}</div>
    {available.message && <p className="provider-discovery-note">{available.message}</p>}
    {selected.size>remaining && <p className="form-error" role="alert">每个供应商最多 256 个模型，还可添加 {remaining} 个，请减少选择。</p>}
    <div className="provider-discovery-actions"><span>添加后保存供应商生效</span><button type="button" className="button primary" disabled={!selected.size || selected.size>remaining} onClick={() => onAdd(names.filter(name => selected.has(name) && !existing.has(name)))}>添加所选模型{selected.size>0 ? `（${selected.size}）` : ""}</button></div>
  </div>;
}
