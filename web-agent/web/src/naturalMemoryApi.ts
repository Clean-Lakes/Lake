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
