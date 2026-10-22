import type {MCPServerConfig,Resource,SkillConfig} from "../../shared/contracts";
import {referencedExtensions, type MentionKind} from "../../shared/references";

export type MentionOption={id:string;kind:MentionKind;name:string;detail:string;resourceKind?:Resource['kind']};
const resourceMentionLabels:Record<Resource['kind'],string>={ssh:'SSH 主机',database:'数据库',redis:'Redis',docker:'容器',local:'本机'};
export function mentionTypeLabel(option:MentionOption):string {
 return option.kind==='resource'?(option.resourceKind&&resourceMentionLabels[option.resourceKind]||'资源'):option.kind==='skill'?'Skill':option.kind==='mcp'?'MCP':'专员';
}
export type MentionCategory=MentionKind|"all";
export const mentionCategories=[{kind:"all",label:"全部"},{kind:"resource",label:"资源"},{kind:"skill",label:"Skills"},{kind:"mcp",label:"MCP"},{kind:"role",label:"专员"}] as const;
export function visibleMentionCategories(options:MentionOption[]) {
 return mentionCategories.filter(group=>group.kind!=="role"||options.some(option=>option.kind==="role"));
}
export function nextMentionCategory(category:MentionCategory,options:MentionOption[],event:{key:string;metaKey?:boolean;ctrlKey?:boolean;altKey?:boolean;shiftKey?:boolean}):MentionCategory|null {
 if((event.key!=="ArrowLeft"&&event.key!=="ArrowRight")||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return null;
 const categories=visibleMentionCategories(options);
 const index=categories.findIndex(group=>group.kind===category);
 return categories[(index+(event.key==="ArrowLeft"?-1:1)+categories.length)%categories.length]!.kind;
}
export function mentionOptions(resources:Resource[],skills:SkillConfig[],servers:MCPServerConfig[],sreEnabled=false):MentionOption[] {
 return [
  ...resources.map(r=>({id:r.id,kind:"resource" as const,resourceKind:r.kind,name:r.name,detail:r.status==="available"?"可用资源":"不可用资源"})),
  ...skills.filter(s=>s.enabled).map(s=>({id:s.name,kind:"skill" as const,name:s.name,detail:s.description||"可复用操作流程"})),
  ...servers.filter(s=>s.enabled).map(s=>({id:s.id,kind:"mcp" as const,name:s.name,detail:s.transport==="stdio"?"本机工具服务":"远程工具服务"})),
  ...(sreEnabled?[['coordinator','协调者','计划与调度'],['investigator','调查员','只读取证'],['executor','执行员','受控执行'],['verifier','验证员','独立复测']].map(([id,name,detail])=>({id:id!,name:name!,detail:detail!,kind:'role' as const})):[]),
 ];
}
export function filterMentions(options:MentionOption[],query:string,category:MentionCategory):MentionOption[] {
 const needle=query.trim().toLocaleLowerCase();
 return options.filter(o=>(category==="all"||o.kind===category)&&`${o.name} ${o.detail} ${o.kind} ${mentionTypeLabel(o)}`.toLocaleLowerCase().includes(needle));
}
export function mentionInsertion(draft:string,caret:number,option:MentionOption) {
 const before=draft.slice(0,caret),token=before.match(/(?:^|\s)@([^\s@]*)$/);
 const start=token?before.lastIndexOf("@"):caret;
 const label=`@${option.name}`,next=`${draft.slice(0,start)}${label} ${draft.slice(caret)}`;
 return {next,position:start+label.length+1,reference:{kind:option.kind,resourceId:option.id,label,start,end:start+label.length}};
}

/** Each atomic reference occupies one UTF-16 code unit in the editable document. */
export const composerToken="\ufffc";
export type ComposerReference={kind:MentionKind;resourceId:string;label:string;position:number};
export function replaceComposerRange(draft:string,references:ComposerReference[],start:number,end:number,text:string,inserted:ComposerReference[]=[]) {
 start=Math.max(0,Math.min(draft.length,start));end=Math.max(start,Math.min(draft.length,end));
 const next=draft.slice(0,start)+text+draft.slice(end),delta=text.length-(end-start);
 const refs=references.flatMap(ref=>ref.position<start?[ref]:ref.position>=end?[{...ref,position:ref.position+delta}]:[]);
 refs.push(...inserted.map(ref=>({...ref,position:ref.position+start})));
 return {next,position:start+text.length,references:refs.filter(ref=>next[ref.position]===composerToken).sort((a,b)=>a.position-b.position)};
}
export function selectComposerMention(draft:string,caret:number,references:ComposerReference[],option:MentionOption) {
 const before=draft.slice(0,caret),token=before.match(/@([^\s@\ufffc]*)$/);
 const start=token?before.lastIndexOf("@"):caret;
 const existing=references.find(ref=>ref.kind===option.kind&&ref.resourceId===option.id);
 return replaceComposerRange(draft,references,start,caret,existing?"":composerToken,existing?[]:[{kind:option.kind,resourceId:option.id,label:`@${option.name}`,position:0}]);
}
export function appendResourceMention(draft:string,references:ComposerReference[],resource:Pick<Resource,"id"|"name">,caret=draft.length,end=caret) {
 const existing=references.find(ref=>ref.kind==="resource"&&ref.resourceId===resource.id);
 if(existing)return {next:draft,references,position:existing.position+1};
 return replaceComposerRange(draft,references,caret,end,composerToken,[{kind:"resource",resourceId:resource.id,label:`@${resource.name}`,position:0}]);
}
export function composerResourceIds(references:ComposerReference[],scope:string[]) {
 return [...new Set(references.filter(ref=>ref.kind==="resource"&&scope.includes(ref.resourceId)).map(ref=>ref.resourceId))];
}
/** Expand tokens in their actual sentence order, retaining verified UTF-16 extension spans. */
export function composerMessage(draft:string,references:ComposerReference[],scope:string[]) {
 const resourceIds=composerResourceIds(references,scope),lookup=new Map(references.map(ref=>[ref.position,ref]));
 let text="";
 const spans=[];
 for(let i=0;i<draft.length;i++) {
  if(draft[i]!==composerToken){text+=draft[i];continue;}
  const ref=lookup.get(i);
  if(!ref||ref.kind==="resource"&&!resourceIds.includes(ref.resourceId))continue;
  const start=text.length;text+=ref.label;spans.push({...ref,start,end:text.length});
 }
 const leading=text.length-text.trimStart().length;
 return {text:text.trim(),resourceIds,references:referencedExtensions(text,spans),mentions:spans.map(ref=>({kind:ref.kind,id:ref.resourceId,label:ref.label,start:ref.start-leading,end:ref.end-leading}))};
}
/** Clipboard tokens bind only to references already selected in this editor session. */
export function composerClipboardFragment(raw:string,known:ComposerReference[]) {
 try {
  const data=JSON.parse(raw) as {version?:unknown;value?:unknown;references?:unknown};
  if(data.version!==1||typeof data.value!=='string'||data.value.length>100000||!Array.isArray(data.references))return null;
  const value=data.value,lookup=new Map(known.map(ref=>[`${ref.kind}:${ref.resourceId}`,ref]));
  const references:ComposerReference[]=[],positions=new Set<number>();
  for(const item of data.references){
   if(!item||typeof item!=='object')return null;
   const ref=item as Record<string,unknown>,position=ref.position;
   const original=lookup.get(`${ref.kind}:${ref.resourceId}`);
   if(!original||typeof position!=='number'||!Number.isInteger(position)||position<0||value[position]!==composerToken||positions.has(position))return null;
   positions.add(position);references.push({...original,position});
  }
  if(value.split(composerToken).length-1!==references.length)return null;
  return {value,references};
 } catch {return null;}
}
