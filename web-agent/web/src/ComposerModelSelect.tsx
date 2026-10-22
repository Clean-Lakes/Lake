import {useState,useRef,useEffect} from "react";
import type {AvailableModelEntry,AvailableModels,ReasoningSettings} from "../../shared/contracts";
import {AppSelect} from "./AppSelect";
import {ProviderIcon} from "./ProviderIcon";
import {Glyph} from "./Icons";
import {currentComposerModel} from "./composerModelState";
import {ReasoningSelector,type ReasoningSelectorProps} from "./ReasoningSelector";
import {useNativeModelPanel} from "./nativeModelPanel";
import {api} from "./api";
import {currentReasoningLabel} from "./reasoningLabels";
import {modelBrand} from "./modelBrand";

export type ProviderMenuRequest={providers:{id:string;name:string}[];value:string;anchor:{left:number;top:number;width:number;height:number}};
export type ComposerModelSelectProps={available:AvailableModels&{loading:boolean};modelName:string|null;selection?:AvailableModelEntry;configured:boolean;open:boolean;disabled:boolean;onOpenChange:(open:boolean)=>void;onSelect:(model:AvailableModelEntry|string)=>void;onSettings:()=>void;reasoning?:ReasoningSelectorProps;presentation?:number;onProviderMenu?:(request:ProviderMenuRequest)=>Promise<string|null>};
export function ComposerModelSelect({available,modelName,selection,configured,open,disabled,onOpenChange,onSelect,onSettings,reasoning,presentation,onProviderMenu}:ComposerModelSelectProps) {
  const anchor=useRef<HTMLSpanElement>(null);
  const providerAnchor=useRef<HTMLDivElement>(null);
  const [level,setLevel]=useState<{session:string;providerId?:string;settings:ReasoningSettings}|null>(null);
  const [reasoningRevision,setReasoningRevision]=useState(0);
  const session=reasoning?.session,modelId=reasoning?.modelId,providerId=selection?.providerId;
  useEffect(()=>{
    let cancelled=false;
    if(session&&modelId)void api.reasoning(session).then(settings=>{
      if(!cancelled&&settings.modelId===modelId)setLevel({session,providerId,settings});
    }).catch(()=>{if(!cancelled)setLevel(null);});
    return()=>{cancelled=true;};
  },[session,modelId,providerId,reasoningRevision]);
  const trackedReasoning=reasoning?{...reasoning,onSaving:(saving:boolean,savingSession=reasoning.session)=>{
    reasoning.onSaving(saving,savingSession);
    // Native popovers have a separate webview. Re-read the saved, model-scoped
    // setting after either surface finishes, including after it closes.
    if(!saving&&savingSession===session)setReasoningRevision(value=>value+1);
  }}:undefined;
  const native=useNativeModelPanel({available,modelName,selection,configured,open,disabled,onOpenChange,onSelect,onSettings,reasoning:trackedReasoning},anchor);
  const [search,setSearch]=useState("");
  const [providerOpen,setProviderOpen]=useState(false);
  useEffect(()=>{if(!open)setProviderOpen(false);},[open]);
  const [source,setSource]=useState<string|null>(null);
  useEffect(()=>{setSource(selection?.providerId??null);setSearch("");},[presentation]);
  if (!configured) return <button type="button" className="composer-model-setup" disabled={disabled} onClick={onSettings} title="连接模型后即可发送，已输入的内容会保留"><Glyph name="plug" size={16}/><span>连接模型</span><Glyph name="chevron" size={12}/></button>;
  const allRows=available.entries?.map(entry=>({value:JSON.stringify([entry.providerId,entry.modelId]),label:entry.displayName,name:entry.name,group:entry.providerName,groupId:entry.providerId,model:entry as AvailableModelEntry|string}))??available.models.map(name=>({value:name,label:name,name,group:"",groupId:"",model:name as AvailableModelEntry|string}));
  const rows=available.loading?[]:allRows;
  const current=currentComposerModel(available,modelName,selection);
  const groups=[...new Set(rows.map(row=>row.groupId))];
  const activeSource=source!==null&&groups.includes(source)?source:groups.includes(current?.providerId||"")?current?.providerId||"":groups[0]||"";
  const currentSource=rows.find(row=>row.groupId===activeSource);
  const sourceRows=rows.filter(row=>row.groupId===activeSource);
  const query=search.trim().toLocaleLowerCase();
  const visible=sourceRows.filter(row=>`${row.label} ${row.name}`.toLocaleLowerCase().includes(query));
  const note=available.message&&(available.source==="magpie"||!available.models.length)?available.message:"";
  const label=configured?(current?.displayName||modelName?.split("/").pop()||"已配置"):"选择模型";
  const levelLabel=level&&level.session===session&&level.providerId===providerId?currentReasoningLabel(level.settings,modelId):undefined;
  const triggerLabel=<span className="composer-model-current"><span className="composer-model-name">{label}</span>{levelLabel&&<span className="composer-model-effort" title={`思考强度：${levelLabel}`}>{levelLabel}</span>}</span>;
  return <span ref={anchor} className="composer-model-anchor"><AppSelect nativePopup={native} selectionLocked={disabled} className={`composer-model-select ${configured?"":"model-missing"}`} popupClassName="composer-model-popup" popupMinWidth={276} popupMaxHeight={420}
    label={configured?`选择模型：${label}${levelLabel?` · 思考强度：${levelLabel}`:""}${current?.providerName?` · ${current.providerName}`:""}`:"选择模型"} title={modelName&&label!==modelName?`${label}\n${modelName}`:label} value={current?JSON.stringify([current.providerId,current.modelId]):modelName||""} renderValue={triggerLabel}
    icon={<ProviderIcon brand={modelBrand(modelName||"",current?.displayName,current?.providerName)} size={16}/>}
    open={open} aria-busy={disabled} onOpenChange={next=>{if(next&&disabled) return;if(next) {setSearch("");setSource(current?.providerId??null);}onOpenChange(next);}}
    onChange={event=>{const row=rows.find(row=>row.value===event.target.value);if(row&&!disabled) onSelect(row.model);}}
    popupHeader={({listId,activeId})=><>
      {currentSource&&<div ref={providerAnchor}><AppSelect className="composer-model-provider" popupClassName="composer-provider-popup" popupPlacement="side" aria-haspopup={onProviderMenu?"menu":"listbox"} label={`切换模型供应商：${currentSource.group||"其他模型"}`} value={activeSource} renderValue={currentSource.group||"其他模型"} icon={<ProviderIcon brand={modelBrand(currentSource.name,currentSource.label,currentSource.group)} size={15}/>} open={providerOpen} nativePopup={!!onProviderMenu}
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
    popupFooter={<>{reasoning&&<ReasoningSelector key={reasoning.session} {...trackedReasoning!}/>}{note&&rows.length>0&&<p className="composer-model-note">{note}</p>}</>}
    renderOption={option=>{const row=rows.find(row=>row.value===option.value)!;return <><ProviderIcon brand={modelBrand(row.name,row.label,row.group)} size={16}/><span className="composer-model-label"><span>{row.label}</span>{row.name!==row.label&&<small>{row.name}</small>}</span>{available.imageInputCapabilities?.[row.name]&&<small className="composer-model-capability">视觉</small>}</>;}}
  >{visible.map(row=><option key={row.value} value={row.value} disabled={disabled&&reasoning?.disabled!==false}>{row.label}</option>)}</AppSelect></span>;
}
