import type {Resource} from '../../shared/contracts';
export const resourceTypeOptions = [['ssh','SSH 主机'],['kubernetes','Kubernetes (K8s)'],['mysql','MySQL'],['postgres','PostgreSQL'],['redis','Redis'],['apisix','APISIX'],['prometheus','Prometheus'],['victoriametrics','VictoriaMetrics (VM 时序库)']] as const;
export type ResourceInputType = typeof resourceTypeOptions[number][0];
export type ServiceDraft = {host:string;port:number;username:string;database:string;db:number;tls:boolean;endpoint:string;context:string;namespace:string;password:string;token:string;apiKey:string;kubeAuthMethod:"kubeconfig"|"token";kubeconfig:string;kubeconfigFileName:string;requestTimeout:number;tlsMode:"config"|"verify"|"skip"};
export function emptyServiceDraft(type:ResourceInputType='postgres'):ServiceDraft {
 return {host:'',port:type==='mysql'?3306:type==='redis'?6379:5432,username:'',database:'',db:0,tls:type!=='redis',endpoint:'',context:'',namespace:'',password:'',token:'',apiKey:'',kubeAuthMethod:'kubeconfig',kubeconfig:'',kubeconfigFileName:'',requestTimeout:10,tlsMode:'config'};
}
export function serviceResourceInput(type:ResourceInputType,v:ServiceDraft) {
 if(type==='ssh') throw new Error('SSH uses its own form');
 if(type==='mysql'||type==='postgres') return {kind:'database',settings:{driver:type,host:v.host.trim(),port:v.port,username:v.username,database:v.database,tls:v.tls,sslmode:v.tls?'verify-full':'disable',password:v.password}};
 if(type==='redis') return {kind:type,settings:{host:v.host.trim(),port:v.port,username:v.username,db:v.db,tls:v.tls,password:v.password}};
 if(type==='kubernetes') return {kind:type,settings:{authMethod:v.kubeAuthMethod,context:v.context.trim(),namespace:v.namespace.trim(),requestTimeout:v.requestTimeout,tlsMode:v.tlsMode,...(v.kubeAuthMethod==='kubeconfig'?{kubeconfig:v.kubeconfig}:{endpoint:v.endpoint.trim(),token:v.token})}};
 if(type==='apisix') return {kind:type,settings:{endpoint:v.endpoint.trim(),apiKey:v.apiKey}};
 return {kind:type,settings:{endpoint:v.endpoint.trim(),username:v.username,password:v.password,token:v.token}};
}
export function resourceTypeLabel(resource:Pick<Resource,'kind'|'settings'>):string {
 if(resource.kind==='database') return ({mysql:'MySQL',postgres:'PostgreSQL',sqlite:'SQLite'} as Record<string,string>)[String(resource.settings?.driver)]??'数据库';
 return ({local:'本机资源',ssh:'SSH 主机',docker:'Docker',redis:'Redis',kubernetes:'Kubernetes (K8s)',apisix:'APISIX',prometheus:'Prometheus',victoriametrics:'VictoriaMetrics (VM 时序库)'})[resource.kind];
}
