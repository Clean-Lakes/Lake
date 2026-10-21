import {ApiRequestError} from './api';
export type StrategyScope={kind:'user'|'project';projectId?:string};
export type StrategyKind='user_preference'|'domain_procedure'|'tool_guidance'|'report_guidance';
export type StrategyApplicability={profiles:string[];resourceKinds:string[];domainTags:string[]};
export type StrategyRef={assetId:string;revision:number;contentHash:string};
export type StrategyAsset={id:string;title:string;scope:StrategyScope;kind:StrategyKind;revision:number;deleted:boolean};
export type StrategyRevision={asset:StrategyAsset;value:{ref:StrategyRef;parentRevision:number;kind:StrategyKind;body:string;applicability:StrategyApplicability;verification:string;sourceIds:string[]};available:boolean;sourcesAvailable:boolean;skillSources?:{name:string;contentHash:string;state:string}[]};
export type StrategyBinding={assetId:string;scope:StrategyScope;revision:number;bindingRevision:number;enabled:boolean;priority:number;exclusionGroup:string};
export type StrategySettings={scope:StrategyScope;revision:number;epoch:number;masterEnabled:boolean;applyEnabled:boolean;learnEnabled:boolean;correctEnabled:boolean;budget:Record<string,number>};
export type StrategySettingsView={settings:StrategySettings;effective:StrategySettings;source:string;capabilities:{apply:boolean;learn:boolean;correct:boolean}};
export type StrategyLineage={nodes:{id:string;kind:string;revision:number;createdAt:string;availability?:string;summary?:string;contentHash?:string;sourceId?:string;sourceKind?:string}[];edges:{id:number;fromId:string;toId:string;relation:string;createdAt:string}[];nextCursor:number;hasMore:boolean;redacted:boolean};
export type StrategyMutation={assetId?:string;revision?:number;bindingRevision?:number};
export type StrategyDraft={title:string;kind:StrategyKind;body:string;applicability:StrategyApplicability};
export function strategyPath(projectId:string){return projectId?`/api/projects/${encodeURIComponent(projectId)}/strategy`:'/api/strategy';}
const pendingMutations=new Map<string,string>();
async function request<T>(base:string,path:string,method='GET',data?:unknown):Promise<T>{
 const body=data!==undefined?JSON.stringify(data):undefined;const operation=method+base+path+body;let key='';if(body!==undefined){key=pendingMutations.get(operation)||crypto.randomUUID();pendingMutations.set(operation,key);}
 const response=await fetch(base+path,{method,credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json',...(data!==undefined?{'Content-Type':'application/json','Idempotency-Key':key}: {})},...(data!==undefined?{body}:{})});
 if(!response.ok){if(response.status<500)pendingMutations.delete(operation);const error=await response.json().catch(()=>null) as {error?:string}|null;throw new ApiRequestError(error?.error||'策略操作失败，请重试',response.status);}
 const result=await response.json() as T;pendingMutations.delete(operation);return result;
}
export const strategyApi={
 settings:(base:string)=>request<StrategySettingsView>(base,'/settings'),
 saveSettings:(base:string,value:StrategySettings)=>request<StrategyMutation>(base,'/settings','PATCH',{expectedRevision:value.revision,masterEnabled:value.masterEnabled,applyEnabled:value.applyEnabled,learnEnabled:value.learnEnabled,correctEnabled:value.correctEnabled,budget:value.budget}),
 assets:(base:string,after='')=>request<{items:StrategyAsset[];nextCursor:string}>(base,`/assets?after=${encodeURIComponent(after)}`),
 create:(base:string,draft:StrategyDraft)=>request<StrategyMutation>(base,'/assets','POST',{...draft,expectedRevision:0}),
 revise:(base:string,id:string,expected:number,parent:number,draft:StrategyDraft)=>request<StrategyMutation>(base,`/assets/${encodeURIComponent(id)}/revisions`,'POST',{...draft,expectedRevision:expected,parentRevision:parent}),
 versions:(base:string,id:string,before=0)=>request<{asset:StrategyAsset;items:{revision:number;parentRevision:number;contentHash:string;verification:string;createdAt:string}[];nextCursor:number}>(base,`/assets/${encodeURIComponent(id)}/revisions${before?`?before=${before}`:''}`),
 revision:(base:string,id:string,version:number)=>request<StrategyRevision>(base,`/assets/${encodeURIComponent(id)}/revisions/${version}`),
 binding:(base:string,id:string)=>request<{binding:StrategyBinding|null}>(base,`/assets/${encodeURIComponent(id)}/bindings`),
 bind:(base:string,id:string,action:string,ref:StrategyRef,binding:StrategyBinding|null,priority:number,exclusionGroup:string)=>request<StrategyMutation>(base,`/assets/${encodeURIComponent(id)}/bindings`,'POST',{action,ref,expectedRevision:binding?.bindingRevision||0,priority,exclusionGroup}),
 lineage:(base:string,id:string,cursor=0)=>request<StrategyLineage>(base,`/assets/${encodeURIComponent(id)}/lineage?cursor=${cursor}`),
 remove:(base:string,id:string,expected:number)=>request<StrategyMutation>(base,`/assets/${encodeURIComponent(id)}`,'DELETE',{expectedRevision:expected}),
 importSkill:(base:string,name:string)=>request<StrategyMutation>(base,'/imports/skill','POST',{expectedRevision:0,name,kind:'domain_procedure',applicability:{profiles:[],resourceKinds:[],domainTags:[]}}),
};
// Portable imports contain user-confirmed content only. Do not trust imported
// IDs, verification, adoption, scope, sources or switch settings.
export function parseStrategyImport(text:string):StrategyDraft {
 if(new TextEncoder().encode(text).length>128000)throw new Error('导入文件过大');
 const raw:unknown=JSON.parse(text);if(!raw||typeof raw!=='object')throw new Error('策略文件格式无效');
 const obj=raw as Record<string,unknown>;
 if(obj.format!=='lake-strategy-v1'||typeof obj.title!=='string'||typeof obj.body!=='string'||!['user_preference','domain_procedure','tool_guidance','report_guidance'].includes(String(obj.kind)))throw new Error('策略文件格式无效');
 const a=obj.applicability as Record<string,unknown>;
 if(!a||!['profiles','resourceKinds','domainTags'].every(k=>Array.isArray(a[k])&&(a[k] as unknown[]).every(v=>typeof v==='string')))throw new Error('适用条件无效');
 return {title:obj.title,kind:obj.kind as StrategyKind,body:obj.body,applicability:{profiles:a.profiles as string[],resourceKinds:a.resourceKinds as string[],domainTags:a.domainTags as string[]}};
}
export function strategyExport(draft:StrategyDraft){return JSON.stringify({format:'lake-strategy-v1',...draft},null,2)+'\n';}

export type StrategySource={id:string;kind:string;sessionId:string;turnId?:string;availability:string;createdAt:string;userText?:string;contentHash:string;outcome?:string;profile?:string;evidence?:{callId:string;tool:string;status:string;resultHash:string}[]};
export type StrategyProposal={id:string;status:string;errorCode:string;attempts:number;createdAt:string;sourceIds:string[];assetId?:string;revision?:number;runStatus?:string;usage?:{input:number;output:number;inputKnown:boolean;outputKnown:boolean};result?:{schemaVersion:number;candidate:{title:string;reason:string;body:string;sourceIds:string[]}|null}};
export const strategyLearningApi={
 sources:(base:string,after='')=>request<{items:StrategySource[];nextCursor:string}>(base,`/sources?after=${encodeURIComponent(after)}`),
 register:(base:string,messageId:string)=>request<StrategyMutation>(base,'/sources','POST',{messageId}),
 withdraw:(base:string,id:string)=>request<StrategyMutation>(base,`/sources/${encodeURIComponent(id)}`,'DELETE',{}),
 proposals:(base:string,after='')=>request<{items:StrategyProposal[];nextCursor:string}>(base,`/proposals?after=${encodeURIComponent(after)}`),
 propose:(base:string,sourceIds:string[])=>request<{jobId:string}>(base,'/proposals','POST',{sourceIds,assetId:'',expectedRevision:0}),
 cancel:(base:string,id:string)=>request<StrategyMutation>(base,`/proposals/${encodeURIComponent(id)}/cancel`,'POST',{}),
};
