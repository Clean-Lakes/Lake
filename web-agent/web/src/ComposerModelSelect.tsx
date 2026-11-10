import {useState,useRef,useEffect} from "react";
import type {AvailableModelEntry,AvailableModels,ReasoningSettings} from "../../shared/contracts";
import {AppSelect} from "./AppSelect";
import {ProviderIcon} from "./ProviderIcon";
import {Glyph} from "./Icons";
import {currentComposerModel,composerModelLabel} from "./composerModelState";
import {ReasoningSelector,type ReasoningSelectorProps} from "./ReasoningSelector";
import {useNativeModelPanel} from "./nativeModelPanel";
import {api} from "./api";
import {currentReasoningLabel} from "./reasoningLabels";
import {modelBrand} from "./modelBrand";
import {ContextUsage,type ContextUsageProps} from "./ContextUsage";
import {codexModelValue,type ComposerExternalAgent} from './composerAgentModel';
export {codexModelValue,codexSettingsValue} from './composerAgentModel';

export type ProviderMenuRequest={providers:{id:string;name:string}[];value:string;anchor:{left:number;top:number;width:number;height:number}};
export type ComposerModelSelectProps={externalAgent?:ComposerExternalAgent;onExternalAgentSelect?:()=>void;onExternalAgentSettings?:()=>void;available:AvailableModels&{loading:boolean};modelName:string|null;selection?:AvailableModelEntry;configured:boolean;open:boolean;disabled:boolean;onOpenChange:(open:boolean)=>void;onSelect:(model:AvailableModelEntry|string)=>void;onSettings:()=>void;reasoning?:ReasoningSelectorProps;contextUsage?:Pick<ContextUsageProps,"view"|"model"|"status">;presentation?:number;onProviderMenu?:(request:ProviderMenuRequest)=>Promise<string|null>};
export function ComposerModelSelect({externalAgent,onExternalAgentSelect,onExternalAgentSettings,available,modelName,selection,configured,open,disabled,onOpenChange,onSelect,onSettings,reasoning,contextUsage,presentation,onProviderMenu}:ComposerModelSelectProps) {
  const anchor=useRef<HTMLSpanElement>(null);
  const providerAnchor=useRef<HTMLDivElement>(null);
  const [level,setLevel]=useState<{session:string;providerId?:string;settings:ReasoningSettings}|null>(null);
  const [reasoningRevision,setReasoningRevision]=useState(0);
  const session=reasoning?.session,modelId=reasoning?.modelId,providerId=selection?.providerId;
  useEffect(()=>{
    let cancelled=false;
    if(session&&modelId&&!externalAgent?.selected)void api.reasoning(session).then(settings=>{
      if(!cancelled&&settings.modelId===modelId)setLevel({session,providerId,settings});
    }).catch(()=>{if(!cancelled)setLevel(null);});
    return()=>{cancelled=true;};
  },[session,modelId,providerId,reasoningRevision,externalAgent?.selected]);
  const trackedReasoning=reasoning?{...reasoning,onSaving:(saving:boolean,savingSession=reasoning.session)=>{
    reasoning.onSaving(saving,savingSession);
    // Native popovers have a separate webview. Re-read the saved, model-scoped
    // setting after either surface finishes, including after it closes.
    if(!saving&&savingSession===session)setReasoningRevision(value=>value+1);
  }}:undefined;
  const native=useNativeModelPanel({externalAgent,onExternalAgentSelect,onExternalAgentSettings,available,modelName,selection,configured:configured||!!externalAgent&&!externalAgent.configurationOnly,open,disabled,onOpenChange,onSelect,onSettings,reasoning:externalAgent?.selected?undefined:trackedReasoning,contextUsage:externalAgent?.selected?undefined:contextUsage},anchor);
  const [search,setSearch]=useState("");
  const [providerOpen,setProviderOpen]=useState(false);
  useEffect(()=>{if(!open)setProviderOpen(false);},[open]);
  const [source,setSource]=useState<string|null>(null);
  useEffect(()=>{setSource(externalAgent?.selected?'agent:codex':selection?'provider:'+selection.providerId:null);setSearch("");},[presentation,externalAgent?.selected]);
  if (!configured&&(!externalAgent||externalAgent.configurationOnly)) return <button type="button" className="composer-model-setup" disabled={disabled} onClick={onSettings} title="连接模型后即可发送，已输入的内容会保留"><Glyph name="plug" size={16}/><span>连接模型</span><Glyph name="chevron" size={12}/></button>;
  const modelRows=available.entries?.map(entry=>({value:JSON.stringify([entry.providerId,entry.modelId]),label:entry.displayName,name:entry.name,group:entry.providerName,groupId:'provider:'+entry.providerId,model:entry as AvailableModelEntry|string,external:false}))??available.models.map(name=>({value:name,label:name,name,group:"",groupId:"provider:",model:name as AvailableModelEntry|string,external:false}));
  const allRows=externalAgent&&!externalAgent.configurationOnly?[{value:codexModelValue,label:'Codex',name:'codex-acp',group:'Codex · Agent',groupId:'agent:codex',model:codexModelValue,external:true},...modelRows]:modelRows;
  // Refreshing the catalog must not remove cached rows or resize an open panel.
  const rows=allRows;
  const current=currentComposerModel(available,modelName,selection);
  const groups=[...new Set(rows.map(row=>row.groupId))];
  const selectedSource=externalAgent?.selected?'agent:codex':'provider:'+(current?.providerId??'');
  const activeSource=source!==null&&groups.includes(source)?source:groups.includes(selectedSource)?selectedSource:groups[0]||"";
  const currentSource=rows.find(row=>row.groupId===activeSource);
  const sourceRows=rows.filter(row=>row.groupId===activeSource);
  const query=search.trim().toLocaleLowerCase();
  const visible=sourceRows.filter(row=>`${row.label} ${row.name}`.toLocaleLowerCase().includes(query));
  const note=available.message&&(available.source==="magpie"||!available.models.length)?available.message:"";
  const label=externalAgent?.selected?'Codex':configured?(current?composerModelLabel(current.displayName,current.name):modelName?.split("/").pop()||"已配置"):"选择模型";
  const levelLabel=!externalAgent?.selected&&level&&level.session===session&&level.providerId===providerId?currentReasoningLabel(level.settings,modelId):undefined;
  const triggerLabel=<span className="composer-model-current"><span className="composer-model-name">{label}</span>{levelLabel&&<span className="composer-model-effort" title={`思考强度：${levelLabel}`}>{levelLabel}</span>}</span>;
  const codexFooter=externalAgent&&<div className="composer-codex-footer">{externalAgent.configurationOnly&&<strong>专员 Codex</strong>}<p role="status">{externalAgent.ready?'已连接本机 Codex，复用已有登录与配置':externalAgent.message||'请先配置 Codex'}</p><button type="button" disabled={disabled} onClick={()=>{onOpenChange(false);onExternalAgentSettings?.();}}><Glyph name="settings" size={14}/>配置 Codex</button>{!externalAgent.configurationOnly&&<small>发送后创建独立任务，进度与结果回到当前专员。</small>}</div>;
  return <span ref={anchor} className="composer-model-anchor"><AppSelect nativePopup={native} selectionLocked={disabled} className={`composer-model-select ${configured||externalAgent?.selected?"":"model-missing"}`} popupClassName="composer-model-popup" popupMinWidth={260} popupAlign="end" popupMaxHeight={420}
    label={`选择模型：${label}${levelLabel?` · 思考强度：${levelLabel}`:""}${externalAgent?.selected?' · 独立 Agent':current?.providerName?` · ${current.providerName}`:""}`} title={externalAgent?.selected?externalAgent.message||'Codex 独立执行':modelName&&label!==modelName?`${label}\n${modelName}`:label} value={externalAgent?.selected?codexModelValue:current?JSON.stringify([current.providerId,current.modelId]):modelName||""} renderValue={triggerLabel}
    icon={<ProviderIcon brand={externalAgent?.selected?'openai':modelBrand(modelName||"",current?.displayName,current?.providerName)} size={16}/>}
    open={open} aria-busy={disabled} onOpenChange={next=>{if(next&&disabled) return;if(next) {setSearch("");setSource(selectedSource);}onOpenChange(next);}}
    onChange={event=>{const row=rows.find(row=>row.value===event.target.value);if(row&&!disabled){if(row.external)onExternalAgentSelect?.();else onSelect(row.model);}}}
    popupHeader={({listId,activeId})=><>
      {currentSource&&<div ref={providerAnchor} className="composer-model-provider-heading"><AppSelect className="composer-model-provider" popupClassName="composer-provider-popup" popupPlacement="side" aria-haspopup={onProviderMenu?"menu":"listbox"} label={`切换模型供应商：${currentSource.group||"其他模型"}`} value={activeSource} title={currentSource.group||"其他模型"} renderValue={currentSource.group||"其他模型"} icon={<ProviderIcon brand={currentSource.external?'openai':modelBrand(currentSource.name,currentSource.label,currentSource.group)} size={15}/>} open={providerOpen} nativePopup={!!onProviderMenu}
        onOpenChange={next=>{
          setProviderOpen(next);
          const rect=providerAnchor.current?.getBoundingClientRect();
          if(next&&onProviderMenu&&rect) void onProviderMenu({anchor:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},providers:groups.map(id=>({id,name:rows.find(row=>row.groupId===id)?.group||"其他模型"})),value:activeSource}).then(value=>{if(value==="__settings__")onSettings();else if(value!==null&&groups.includes(value)){setSource(value);setSearch("");}}).catch(()=>{}).finally(()=>setProviderOpen(false));
        }}
        onChange={event=>{if(event.target.value==="__settings__")onSettings();else {setSource(event.target.value);setSearch("");}}}
      >{groups.map(id=><option key={id} value={id}>{rows.find(row=>row.groupId===id)?.group||"其他模型"}</option>)}<optgroup label=" "><option value="__settings__">管理模型</option></optgroup></AppSelect></div>}
      {sourceRows.length>8&&<label className="composer-model-search"><Glyph name="search" size={15}/><input autoFocus role="combobox" aria-expanded={open} aria-controls={listId} aria-activedescendant={activeId} aria-autocomplete="list" aria-label="搜索模型" placeholder="搜索当前分类…" value={search} onChange={event=>setSearch(event.target.value)}/></label>}
    </>}
    emptyMessage={available.loading?"正在获取可用模型…":query?"没有找到匹配的模型":note||"暂无可用模型，请先添加供应商。"}
    popupFooter={<>{currentSource?.external?codexFooter:<>{!externalAgent?.selected&&reasoning&&<ReasoningSelector key={reasoning.session} {...trackedReasoning!}/>}{!externalAgent?.selected&&contextUsage&&<ContextUsage key={contextUsage.view.session} {...contextUsage} presentation="menu"/>}{note&&rows.length>0&&<p className="composer-model-note">{note}</p>}{externalAgent?.configurationOnly&&codexFooter}</>}</>}
    renderOption={option=>{const row=rows.find(row=>row.value===option.value)!;return <><ProviderIcon brand={row.external?'openai':modelBrand(row.name,row.label,row.group)} size={16}/><span className="composer-model-label" title={row.external?'独立 Codex Agent':row.name===row.label?row.label:`${row.label}\n${row.name}`}><span>{row.external?`Codex · ${externalAgent?.model||'本机默认模型'}`:composerModelLabel(row.label,row.name)}</span></span>{row.external?<small className="composer-model-capability">ACP</small>:available.imageInputCapabilities?.[row.name]&&<small className="composer-model-capability">视觉</small>}</>;}}
  >{visible.map(row=><option key={row.value} value={row.value} disabled={disabled&&reasoning?.disabled!==false}>{composerModelLabel(row.label,row.name)}</option>)}</AppSelect></span>;
}
