import {ApiRequestError} from './api';
export type StrategyScope={kind:'user'|'project';projectId?:string};
export type StrategyKind='user_preference'|'domain_procedure'|'tool_guidance'|'report_guidance';
export type StrategyApplicability={profiles:string[];resourceKinds:string[];domainTags:string[]};
export type StrategyRef={assetId:string;revision:number;contentHash:string};
export type StrategyAsset={id:string;title:string;scope:StrategyScope;kind:StrategyKind;revision:number;deleted:boolean};
export type StrategyRevision={asset:StrategyAsset;value:{ref:StrategyRef;parentRevision:number;kind:StrategyKind;body:string;applicability:StrategyApplicability;verification:string;sourceIds:string[]};available:boolean;sourcesAvailable:boolean;skillSources?:{name:string;contentHash:string;state:string}[]};
export type StrategyBinding={assetId:string;scope:StrategyScope;revision:number;bindingRevision:number;enabled:boolean;priority:number;exclusionGroup:string};
export type StrategySettings={scope:StrategyScope;revision:number;epoch:number;masterEnabled:boolean;applyEnabled:boolean;learnEnabled:boolean;correctEnabled:boolean;onlineCorrectEnabled?:boolean;budget:Record<string,number>};
export type StrategySettingsView={settings:StrategySettings;effective:StrategySettings;source:string;capabilities:{apply:boolean;learn:boolean;correct:boolean}};
export function strategySettingsForm(s:StrategySettingsView):StrategySettingsView{return s.source==='inherited'?{...s,settings:{...s.settings,masterEnabled:s.effective.masterEnabled,applyEnabled:s.effective.applyEnabled,learnEnabled:s.effective.learnEnabled,correctEnabled:s.effective.correctEnabled,onlineCorrectEnabled:!!s.effective.onlineCorrectEnabled,budget:s.effective.budget}}:s;}
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
 saveSettings:(base:string,value:StrategySettings)=>request<StrategyMutation>(base,'/settings','PATCH',{expectedRevision:value.revision,masterEnabled:value.masterEnabled,applyEnabled:value.applyEnabled,learnEnabled:value.learnEnabled,correctEnabled:value.correctEnabled,onlineCorrectEnabled:!!value.onlineCorrectEnabled,budget:value.budget}),
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

export type StrategyFixture={id:string;split:string;domain:string;profile:string;prompt:string;version:string};
export type StrategyExperimentSummary={id:string;status:string;errorCode:string;createdAt:string;requests:number;tokensCharged:number};
export type StrategyExperimentRun={id:string;caseId:string;split:string;arm:string;variant?:string;repetition:number;status:string;candidateApplied?:boolean;repeatedObservations?:number;result?:{status:string;answer:string;runtimeId:string;resetHash:string;resetNonce:string;observed:number;violations:number;requests:number;durationMs:number;usage:{inputKnown:boolean;outputKnown:boolean;input:number;output:number};errorCode?:string;manifests:{requestId:string;runId:string;fixedRulesHash:string;builtinStrategyHash:string;toolCatalogHash:string;selectedAssets:StrategyRef[]}[];evaluation:{status:string;checks:Record<string,boolean>;limitations:string[]}}};
export type StrategyExperimentReport={id:string;status:string;errorCode:string;mode:string;frozenHash:string;requests:number;tokensCharged:number;verdict:string;contentAvailable:boolean;contextHash?:string;modelRef?:string;modelHash?:string;skillHashes?:Record<string,string>;assetRef?:StrategyRef;runs:StrategyExperimentRun[];splits:Record<string,{candidateWins:number;regressions:number;ties:number;missing:number}>;limitations:string[];stage?:number;stopReason?:string;noProgress?:number;activeMs?:number;waitUntilMs?:number;savedRevision?:number;expectedRevision?:number;canSave?:boolean;canResume?:boolean;calls?:{id:string;stage:string;status:string;requestHash:string;reservedTokens:number;errorCode:string;result?:{candidate:{body:string;reason:string;refutedHypothesis:string;changes:string;expectedInformation:string;stopCondition:string;sourceRunIds:string[]}|null}}[]};
export const strategyExperimentApi={
 fixtures:(base:string)=>request<{items:StrategyFixture[]}>(base,'/fixtures'),
 list:(base:string)=>request<{items:StrategyExperimentSummary[]}>(base,'/experiments'),
 create:(base:string,ref:StrategyRef,caseIds:string[],repetitions:number,skillNames:string[])=>request<{jobId:string}>(base,'/experiments','POST',{ref,caseIds,repetitions,skillNames}),
 optimize:(base:string,ref:StrategyRef,caseIds:string[],skillNames:string[])=>request<{jobId:string}>(base,'/experiments','POST',{ref,caseIds,repetitions:1,skillNames,optimization:true}),
 resume:(base:string,id:string)=>request<StrategyMutation>(base,`/experiments/${encodeURIComponent(id)}/resume`,'POST',{}),
 saveCandidate:(base:string,id:string,expectedRevision:number)=>request<StrategyMutation>(base,`/experiments/${encodeURIComponent(id)}/save-candidate`,'POST',{expectedRevision}),
 report:(base:string,id:string)=>request<StrategyExperimentReport>(base,`/experiments/${encodeURIComponent(id)}/report`),
 cancel:(base:string,id:string)=>request<StrategyMutation>(base,`/experiments/${encodeURIComponent(id)}/cancel`,'POST',{}),
 erase:(base:string,id:string)=>request<StrategyMutation>(base,`/experiments/${encodeURIComponent(id)}`,'DELETE',{}),
};
export function strategyExperimentAnswer(answer:string){try{const value=JSON.parse(answer) as {answer?:unknown};return typeof value.answer==='string'?value.answer:answer;}catch{return answer;}}
