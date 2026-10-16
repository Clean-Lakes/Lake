import type {MCPServerConfig,Resource,SkillConfig} from "../../shared/contracts";
import type {MentionKind} from "../../shared/references";

export type MentionOption={id:string;kind:MentionKind;name:string;detail:string};
export type MentionCategory=MentionKind|"all";
export const mentionCategories=[{kind:"all",label:"全部"},{kind:"resource",label:"资源"},{kind:"skill",label:"Skills"},{kind:"mcp",label:"MCP"},{kind:"role",label:"专员"}] as const;
export function mentionOptions(resources:Resource[],skills:SkillConfig[],servers:MCPServerConfig[],sreEnabled=false):MentionOption[] {
 return [
  ...resources.map(r=>({id:r.id,kind:"resource" as const,name:r.name,detail:r.status==="available"?"可用资源":"不可用资源"})),
  ...skills.filter(s=>s.enabled).map(s=>({id:s.name,kind:"skill" as const,name:s.name,detail:s.description||"可复用操作流程"})),
  ...servers.filter(s=>s.enabled).map(s=>({id:s.id,kind:"mcp" as const,name:s.name,detail:s.transport==="stdio"?"本机工具服务":"远程工具服务"})),
  ...(sreEnabled?[['coordinator','协调者','计划与调度'],['investigator','调查员','只读取证'],['executor','执行员','受控执行'],['verifier','验证员','独立复测']].map(([id,name,detail])=>({id:id!,name:name!,detail:detail!,kind:'role' as const})):[]),
 ];
}
export function filterMentions(options:MentionOption[],query:string,category:MentionCategory):MentionOption[] {
 const needle=query.trim().toLocaleLowerCase();
 return options.filter(o=>(category==="all"||o.kind===category)&&`${o.name} ${o.detail} ${o.kind}`.toLocaleLowerCase().includes(needle));
}
export function mentionInsertion(draft:string,caret:number,option:MentionOption) {
 const before=draft.slice(0,caret),token=before.match(/(?:^|\s)@([^\s@]*)$/);
 const start=token?before.lastIndexOf("@"):caret;
 const label=`@${option.name}`,next=`${draft.slice(0,start)}${label} ${draft.slice(caret)}`;
 return {next,position:start+label.length+1,reference:{kind:option.kind,resourceId:option.id,label,start,end:start+label.length}};
}
