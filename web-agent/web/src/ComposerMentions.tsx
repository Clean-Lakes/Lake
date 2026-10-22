import {useEffect,useRef,useState,type PointerEvent} from "react";
import {api,readableError} from "./api";
import {Glyph,ResourceIcon} from "./Icons";
import {AgentIcon,type AgentIconName} from './AgentIcon';
import type {MCPServerConfig,SkillConfig} from "../../shared/contracts";
import {visibleMentionCategories,mentionTypeLabel,type MentionCategory,type MentionOption} from "./composerMentionState";
import "./composerMentions.css";

export function useMentionExtensions(open:boolean,sessionId:string|null) {
 const [catalog,setCatalog]=useState<{skills:SkillConfig[];servers:MCPServerConfig[]}>({skills:[],servers:[]});
 const [loading,setLoading]=useState(false),[error,setError]=useState("");
 const [revision,reload]=useState(0);
 useEffect(()=>{
  if(!open||!sessionId)return;
  let cancelled=false;setLoading(true);setError("");setCatalog({skills:[],servers:[]});
  void Promise.allSettled([api.skills(),api.mcpServers()]).then(([skills,servers])=>{
   if(cancelled)return;
   setCatalog({skills:skills.status==="fulfilled"?skills.value.skills:[],servers:servers.status==="fulfilled"?servers.value.servers:[]});
   const failures=[skills,servers].flatMap(result=>result.status==="rejected"?[readableError(result.reason)]:[]);
   setError(failures.length?`扩展列表未能完整加载：${failures.join("；")}`:"");setLoading(false);
  });return()=>{cancelled=true;};
 },[open,sessionId,revision]);
 return {...catalog,loading,error,reload:()=>reload(value=>value+1)};
}
export const mentionOptionId=(option:MentionOption)=>`composer-mention-${option.kind}-${encodeURIComponent(option.id)}`;
export function ComposerMentions({options,allOptions,index,category,onCategory,onActive,onSelect,loading,error,onReload,onImport,onClose}:{options:MentionOption[];allOptions:MentionOption[];index:number;category:MentionCategory;onCategory:(kind:MentionCategory)=>void;onActive:(index:number)=>void;onSelect:(option:MentionOption)=>void;loading:boolean;error:string;onReload:()=>void;onImport:()=>void;onClose:()=>void}) {
 const list=useRef<HTMLDivElement>(null),menu=useRef<HTMLDivElement>(null);
 const pointer=useRef<{x:number;y:number}|null>(null);
 function activate(event:PointerEvent<HTMLButtonElement>,next:number){
  if(event.pointerType==='touch')return;
  const previous=pointer.current,moved=!previous||previous.x!==event.clientX||previous.y!==event.clientY;
  pointer.current={x:event.clientX,y:event.clientY};
  // A keyboard scroll can put a different row under a stationary pointer.
  // Compare coordinates rather than movementX/Y, which WebViews may report as 0.
  if(moved&&next!==index)onActive(next);
 }
 useEffect(()=>{const close=(event:MouseEvent)=>{if(!menu.current?.contains(event.target as Node)&&!(event.target as Element).closest?.("#message-input"))onClose();};document.addEventListener("mousedown",close);return()=>document.removeEventListener("mousedown",close);},[onClose]);
 useEffect(()=>{list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:"nearest"});},[index,options]);
 return <div ref={menu} className="mention-menu composer-mentions" aria-label={allOptions.some(o=>o.kind==="role")?"引用资源、专员、Skills 或 MCP":"引用资源、Skills 或 MCP"} onMouseDown={event=>event.preventDefault()}>
  <div className="mention-categories" role="group" aria-label="引用类型">{visibleMentionCategories(allOptions).map(group=><button key={group.kind} type="button" aria-pressed={group.kind===category} onClick={()=>onCategory(group.kind)}>{group.label}<small>{group.kind==="all"?allOptions.length:allOptions.filter(o=>o.kind===group.kind).length}</small></button>)}</div>
  <div className="mention-results" id="composer-mention-options" ref={list} role="listbox" aria-label="引用候选" aria-busy={loading}>
   {options.map((option,i)=><button key={`${option.kind}:${option.id}`} id={mentionOptionId(option)} tabIndex={-1} type="button" role="option" aria-selected={i===index} className={`mention-item ${i===index?"selected":""}`} onPointerEnter={event=>activate(event,i)} onPointerMove={event=>activate(event,i)} onClick={()=>onSelect(option)}>{option.kind==="role"?<AgentIcon role={option.id as AgentIconName} size={18}/>:option.kind==='resource'?<ResourceIcon kind={option.resourceKind??'ssh'} size={16}/>:<Glyph name={option.kind==="skill"?"book":"plug"} size={16}/>}<span className="mention-copy"><strong>{option.name}</strong><small title={option.detail}>{option.detail}</small></span><span className="mention-kind">{mentionTypeLabel(option)}</span></button>)}
   {!options.length&&<p className="mention-empty">{loading?"正在加载…":category==="skill"?"没有匹配的已启用 Skill":category==="mcp"?"没有匹配的已启用 MCP 服务":"没有匹配的引用"}</p>}
  </div>
  {error&&<div className="mention-error" role="status">{error}<button type="button" onClick={onReload}>重试</button></div>}
  <div className="mention-footer"><span>←→ 分类 · ↑↓ 选择 · Tab / Enter 引用</span>{(category==="all"||category==="resource")&&<button type="button" onClick={onImport}><Glyph name="plus" size={13}/>导入资源</button>}</div>
 </div>;
}
