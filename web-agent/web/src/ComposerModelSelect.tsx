import {useState} from "react";
import type {AvailableModelEntry,AvailableModels} from "../../shared/contracts";
import {AppSelect} from "./AppSelect";
import {ProviderIcon} from "./ProviderIcon";
import {Glyph} from "./Icons";
import {currentComposerModel} from "./composerModelState";
import {modelBrand} from "./modelBrand";

type Props={available:AvailableModels&{loading:boolean};modelName:string|null;selection?:AvailableModelEntry;configured:boolean;open:boolean;disabled:boolean;onOpenChange:(open:boolean)=>void;onSelect:(model:AvailableModelEntry|string)=>void;onSettings:()=>void};
export function ComposerModelSelect({available,modelName,selection,configured,open,disabled,onOpenChange,onSelect,onSettings}:Props) {
  const [search,setSearch]=useState("");
  if (!configured) return <button type="button" className="composer-model-setup" disabled={disabled} onClick={onSettings} title="连接模型后即可发送，已输入的内容会保留"><Glyph name="plug" size={16}/><span>连接模型</span><Glyph name="chevron" size={12}/></button>;
  const allRows=available.entries?.map(entry=>({value:JSON.stringify([entry.providerId,entry.modelId]),label:entry.displayName,name:entry.name,group:entry.providerName,groupId:entry.providerId,model:entry as AvailableModelEntry|string}))??available.models.map(name=>({value:name,label:name,name,group:"",groupId:"",model:name as AvailableModelEntry|string}));
  const rows=available.loading?[]:allRows;
  const current=currentComposerModel(available,modelName,selection);
  const query=search.trim().toLocaleLowerCase();
  const visible=rows.filter(row=>`${row.label} ${row.name} ${row.group}`.toLocaleLowerCase().includes(query));
  const groups=[...new Set(visible.map(row=>row.groupId))];
  const note=available.message&&(available.source==="magpie"||!available.models.length)?available.message:"";
  const label=configured?(current?.displayName||modelName?.split("/").pop()||"已配置"):"选择模型";
  return <AppSelect className={`composer-model-select ${configured?"":"model-missing"}`} popupClassName="composer-model-popup" popupMinWidth={320} popupMaxHeight={420}
    label={configured?`选择模型：${label}${current?.providerName?` · ${current.providerName}`:""}`:"选择模型"} title={modelName&&label!==modelName?`${label}\n${modelName}`:label} value={current?JSON.stringify([current.providerId,current.modelId]):modelName||""} renderValue={label}
    icon={<ProviderIcon brand={modelBrand(modelName||"",current?.displayName,current?.providerName)} size={16}/>}
    open={open} aria-busy={disabled} onOpenChange={next=>{if(next&&disabled) return;if(next) setSearch("");onOpenChange(next);}}
    onChange={event=>{const row=rows.find(row=>row.value===event.target.value);if(row) onSelect(row.model);}}
    popupHeader={({listId,activeId})=><><div className="composer-model-heading">选择模型</div>{rows.length>8&&<label className="composer-model-search"><Glyph name="search" size={15}/><input autoFocus role="combobox" aria-expanded={open} aria-controls={listId} aria-activedescendant={activeId} aria-autocomplete="list" aria-label="搜索模型" placeholder="搜索模型或厂商…" value={search} onChange={event=>setSearch(event.target.value)}/></label>}</>}
    emptyMessage={available.loading?"正在获取可用模型…":query?"没有找到匹配的模型":note||"暂无可用模型，请先添加供应商。"}
    popupFooter={<>{note&&rows.length>0&&<p className="composer-model-note">{note}</p>}<button type="button" className="composer-model-settings" onClick={onSettings}><Glyph name="settings" size={15}/><span>模型设置</span><Glyph name="arrow" size={14}/></button></>}
    renderOption={option=>{const row=rows.find(row=>row.value===option.value)!;return <><ProviderIcon brand={modelBrand(row.name,row.label,row.group)} size={20}/><span className="composer-model-label"><span>{row.label}</span>{row.name!==row.label&&<small>{row.name}</small>}</span></>;}}
  >{groups.map(group=>group?<optgroup key={group} label={visible.find(row=>row.groupId===group)!.group}>{visible.filter(row=>row.groupId===group).map(row=><option key={row.value} value={row.value} disabled={disabled}>{row.label}</option>)}</optgroup>:visible.filter(row=>!row.groupId).map(row=><option key={row.value} value={row.value} disabled={disabled}>{row.label}</option>))}</AppSelect>;
}
