import type {MCPServerConfig,Resource,SkillConfig} from "../../shared/contracts";
import {referencedExtensions, type MentionKind} from "../../shared/references";

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

/** Selected tokens are separate from editable prose; their identity never depends on matching names. */
export type ComposerReference={kind:MentionKind;resourceId:string;label:string};
function addReference(references:ComposerReference[],option:MentionOption):ComposerReference[] {
 return references.some(ref=>ref.kind===option.kind&&ref.resourceId===option.id)?references:[...references,{kind:option.kind,resourceId:option.id,label:`@${option.name}`}];
}
export function selectComposerMention(draft:string,caret:number,references:ComposerReference[],option:MentionOption) {
 const before=draft.slice(0,caret),token=before.match(/(?:^|\s)@([^\s@]*)$/);
 const start=token?before.lastIndexOf("@"):caret;
 return {next:draft.slice(0,start)+draft.slice(caret),position:start,references:addReference(references,option)};
}
export function appendResourceMention(draft:string,references:ComposerReference[],resource:Pick<Resource,"id"|"name">) {
 return {next:draft,position:draft.length,references:addReference(references,{id:resource.id,name:resource.name,kind:"resource",detail:""})};
}
export function composerResourceIds(references:ComposerReference[],scope:string[]) {
 return [...new Set(references.filter(ref=>ref.kind==="resource"&&scope.includes(ref.resourceId)).map(ref=>ref.resourceId))];
}
/** Retain the existing verified extension-span protocol, without repeating tokens in the editor. */
export function composerMessage(draft:string,references:ComposerReference[],scope:string[]) {
 const resources=composerResourceIds(references,scope),body=draft.trim();
 const extensions=references.filter(ref=>ref.kind!=="resource");
 const tokens=body?extensions:references.filter(ref=>ref.kind!=="resource"||resources.includes(ref.resourceId));
 let prefix="";
 const spans=tokens.map(ref=>{const start=prefix.length;prefix+=ref.label+" ";return {...ref,start,end:start+ref.label.length};});
 const text=(prefix+body).trim();
 return {text,resourceIds:resources,references:referencedExtensions(text,spans)};
}
