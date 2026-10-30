import {ApiRequestError} from './api';
type MemoryScope={kind:'user'|'project';projectId?:string};
export type NaturalMemorySettings={scope:MemoryScope;revision:number;autoEnabled:boolean;automaticReady:boolean;recallSettings:{revision:number;useEnabled:boolean};projectMemorySettings:{useEnabled:boolean;extractionEnabled:boolean}|null};
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
 projectEntries:(base:string)=>request<{items:{key:string;description:string;revision:number}[];total:number}>(base,'/project-entries'),
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
 recallSettings:async(base:string,revision:number,useEnabled:boolean)=>{
  const body=JSON.stringify({expectedRevision:revision,useEnabled}),operation=base+'/recall-settings'+body;
  const key=pending.get(operation)||crypto.randomUUID();pending.set(operation,key);
  const response=await fetch(base+'/recall-settings',{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json','Idempotency-Key':key},body});
  if(!response.ok){if(response.status<500)pending.delete(operation);throw new ApiRequestError('记忆使用设置已变化，请刷新后重试',response.status)}
  pending.delete(operation);return response.json() as Promise<{revision:number;useEnabled:boolean}>;
 },
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
