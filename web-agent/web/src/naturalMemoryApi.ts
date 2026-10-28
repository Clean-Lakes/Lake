import {ApiRequestError} from './api';
import type {StrategyApplicability,StrategyReuse,StrategyScope} from './strategyApi';
export type NaturalMemorySettings={scope:StrategyScope;revision:number;autoEnabled:boolean;automaticReady:boolean;preferenceSettings:{effectiveUseEnabled:boolean};projectMemorySettings:{useEnabled:boolean;extractionEnabled:boolean}|null};
export type NaturalLegacy={id:string;title:string;eligible:boolean;reason:string;linkState:string;linkRevision:number;contentRevision:number};
export type NaturalPreview=NaturalLegacy&{body:string;previewToken:string;scope:StrategyScope;applicability:StrategyApplicability;reuse:StrategyReuse;binding:{priority:number;exclusionGroup:string};assessment:{conditions:string;evidence:string;limitations:string}};
export type NaturalPreference={id:string;title:string;revision:number;contentRevision:number;state:string};
export type NaturalChange={id:string;assetId:string;kind:string;createdAt:string;undoneBy:string;revision:number};
export type NaturalPage<T>={items:T[];nextCursor:string};
export const naturalMemoryPath=(projectId:string)=>projectId?`/api/projects/${encodeURIComponent(projectId)}/natural-memory`:'/api/natural-memory';
const pending=new Map<string,string>();
async function request<T>(base:string,path:string,data?:unknown):Promise<T>{
 const body=data===undefined?undefined:JSON.stringify(data),operation=base+path+body;
 let key='';if(body!==undefined){key=pending.get(operation)||crypto.randomUUID();pending.set(operation,key);}
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key})},...(body===undefined?{}:{body})});
 if(!response.ok){if(response.status<500)pending.delete(operation);const value=await response.json().catch(()=>null);throw new ApiRequestError(value?.error||'记忆内容已变化，请刷新后重试',response.status);}
 const result=await response.json() as T;pending.delete(operation);return result;
}
export const naturalMemoryApi={
 settings:(base:string)=>request<NaturalMemorySettings>(base,'/settings'),
 legacy:(base:string,after='')=>request<NaturalPage<NaturalLegacy>>(base,'/legacy?after='+encodeURIComponent(after)),
 preferences:(base:string,after='')=>request<NaturalPage<NaturalPreference>>(base,'/preferences?after='+encodeURIComponent(after)),
 changes:(base:string,after='')=>request<NaturalPage<NaturalChange>>(base,'/changes?after='+encodeURIComponent(after)),
 projectEntries:(base:string)=>request<{items:{key:string;description:string;revision:number}[];total:number}>(base,'/project-entries'),
 preview:(base:string,id:string)=>request<NaturalPreview>(base,'/legacy/'+encodeURIComponent(id)+'/preview'),
 carry:(base:string,p:NaturalPreview)=>request<{id:string;revision:number;changeId:string}>(base,'/legacy/'+encodeURIComponent(p.id)+'/carry',{expectedRevision:p.linkRevision,previewToken:p.previewToken}),
 undo:(base:string,changeId:string,revision:number)=>request<{id:string;revision:number;changeId:string}>(base,'/changes/'+encodeURIComponent(changeId)+'/undo',{expectedRevision:revision}),
};
export type FormedPreference={id:string;topic:string;revision:number;contentRevision:number;body:string;state:string;scope:string;source:{private:boolean;available:boolean;sessionId?:string;messageId?:string};parentRevision:number;sources?:{available:boolean;private:boolean;sessionId?:string;messageId?:string}[]};
export type FormedChange={id:string;entryId:string;beforeRevision:number;afterRevision:number;kind:string;createdAt:string;undoneBy:string;before?:FormedPreference|null;after?:FormedPreference};
export type NaturalNotice={changeId:string;scope:string;entryId:string;revision:number;batchId?:string};
export const naturalNoticeBase=(scope:string)=>naturalMemoryPath(scope==='user'?'':scope.slice('project:'.length));
export const naturalPreferenceApi={
 list:(base:string,after='')=>request<NaturalPage<FormedPreference>>(base,'/formed-preferences?after='+encodeURIComponent(after)),
 changes:(base:string,after='')=>request<NaturalPage<FormedChange>>(base,'/formed-changes?after='+encodeURIComponent(after)),
 change:(base:string,id:string)=>request<FormedChange>(base,'/formed-changes/'+encodeURIComponent(id)),
 read:(base:string,id:string)=>request<FormedPreference>(base,'/formed-preferences/'+encodeURIComponent(id)),
 undo:(base:string,id:string,revision:number)=>request<{revision:number}>(base,'/formed-changes/'+encodeURIComponent(id)+'/undo',{expectedRevision:revision}),
 forget:(base:string,id:string,revision:number)=>request<{revision:number}>(base,'/formed-preferences/'+encodeURIComponent(id)+'/forget',{expectedRevision:revision}),
 dismiss:(base:string,id:string)=>request<{dismissed:boolean}>(base,'/formed-changes/'+encodeURIComponent(id)+'/dismiss',{}),
 settings:async(base:string,revision:number,autoEnabled:boolean)=>{
  const operation=base+'/settings'+JSON.stringify({expectedRevision:revision,autoEnabled});
  const key=pending.get(operation)||crypto.randomUUID();pending.set(operation,key);
  const response=await fetch(base+'/settings',{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({expectedRevision:revision,autoEnabled})});
  if(!response.ok){if(response.status<500)pending.delete(operation);throw new ApiRequestError('记忆设置已变化，请刷新后重试',response.status)}
  pending.delete(operation);return response.json() as Promise<{revision:number;autoEnabled:boolean}>;
 },
};

export type NaturalConflict={id:string;entryId:string;expectedRevision:number;currentRevision:number;body:string;status:string;stale:boolean;source:{available:boolean;private:boolean};createdAt:string};
export type ConsolidationStatus={captured:number;processed:number;deferred:number;withdrawn:number;conflicts:number};
export const naturalConsolidationApi={
 status:(base:string)=>request<ConsolidationStatus>(base,'/consolidation'),
 conflicts:(base:string,after='')=>request<NaturalPage<NaturalConflict>>(base,'/conflicts?after='+encodeURIComponent(after)),
 reject:(base:string,id:string,revision:number)=>request<{status:string}>(base,'/conflicts/'+encodeURIComponent(id)+'/reject',{expectedRevision:revision}),
};
