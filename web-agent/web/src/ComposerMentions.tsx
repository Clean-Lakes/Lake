import {useEffect,useLayoutEffect,useRef,useState,type PointerEvent} from "react";
import {api,readableError} from "./api";
import {Glyph,ResourceIcon,type GlyphName} from "./Icons";
import {RoleMentionAvatar} from './RoleMentionAvatar';
import {TabSelectionIndicator} from "./TabSelectionIndicator";
import {useMenuMotion} from "./useMenuMotion";
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

const categoryGlyphs: Record<MentionCategory,GlyphName> = {
 all: "listTasks", role: "lakeSpecialists", resource: "lakeResources",
 jumpserver: "shield", skill: "book", mcp: "plug",
};
const emptyMessages: Partial<Record<MentionCategory,string>> = {
 jumpserver: "没有匹配的 JumpServer 资产",
 skill: "没有匹配的已启用 Skill",
 mcp: "没有匹配的已启用 MCP 服务",
};

function revealActiveItem(scroller: HTMLDivElement|null, selector: string) {
 const item=scroller?.querySelector<HTMLButtonElement>(selector);
 if(!scroller||!item)return;
 const top=item.offsetTop, bottom=top+item.offsetHeight;
 // Keep automatic scrolling inside the picker, even when it overlays the transcript.
 if(top<scroller.scrollTop)scroller.scrollTop=top;
 else if(bottom>scroller.scrollTop+scroller.clientHeight)scroller.scrollTop=bottom-scroller.clientHeight;
}

type ComposerMentionsProps = {
 options: MentionOption[];
 allOptions: MentionOption[];
 index: number;
 query: string;
 category: MentionCategory;
 onCategory: (kind: MentionCategory)=>void;
 onActive: (index: number)=>void;
 onSelect: (option: MentionOption)=>void;
 loading: boolean;
 error: string;
 onReload: ()=>void;
 onImport: ()=>void;
 onClose: ()=>void;
 onFocusInput: ()=>void;
};

export function ComposerMentions({
 options, allOptions, index, query, category, onCategory, onActive, onSelect,
 loading, error, onReload, onImport, onClose, onFocusInput,
}: ComposerMentionsProps) {
 const list=useRef<HTMLDivElement>(null),menu=useRef<HTMLDivElement>(null),categories=useRef<HTMLDivElement>(null);
 const pointer=useRef<{x:number;y:number}|null>(null);
 const activeOption=options[index];
 const activeId=activeOption&&mentionOptionId(activeOption);
 const activeDetail=activeOption&&(activeOption.detail||mentionTypeLabel(activeOption));

 function activate(event:PointerEvent<HTMLButtonElement>,next:number){
  if(event.pointerType==='touch')return;
  const previous=pointer.current,moved=!previous||previous.x!==event.clientX||previous.y!==event.clientY;
  pointer.current={x:event.clientX,y:event.clientY};
  // A keyboard scroll can put a different row under a stationary pointer.
  // Compare coordinates rather than movementX/Y, which WebViews may report as 0.
  if(moved&&next!==index)onActive(next);
 }
 useEffect(()=>{
  const close=(event:Event)=>{if(event.target instanceof Element&&!menu.current?.contains(event.target)&&!event.target.closest("#message-input"))onClose();};
  document.addEventListener("mousedown",close);document.addEventListener("focusin",close);
  return()=>{document.removeEventListener("mousedown",close);document.removeEventListener("focusin",close);};
 },[onClose]);
 useMenuMotion(menu,true,true);
 useLayoutEffect(()=>revealActiveItem(list.current,'[aria-selected="true"]'),[activeId,index,category,query,error]);
 useLayoutEffect(()=>revealActiveItem(categories.current,'[aria-pressed="true"]'),[category]);

 function dismiss() {
  onClose();
  onFocusInput();
 }

 return <div ref={menu} className="mention-menu composer-mentions" data-menu-motion="true" style={{transformOrigin:"bottom left"}} role="group" aria-label="插入引用"
  onMouseDown={event=>event.preventDefault()} onKeyDown={event=>{
   if(event.key!=="Escape")return;
   event.preventDefault();
   event.stopPropagation();
   dismiss();
  }}>
  <div className="mention-header">
   <strong className="mention-title"><Glyph name="at" size={15}/>插入引用</strong>
   <button type="button" className="mention-query" aria-label="在输入框中搜索引用" onClick={onFocusInput}
    data-filled={!!query||undefined} title={query||"名称、地址或类型"}>
    <Glyph name="search" size={13}/><span>{query||"名称、地址或类型"}</span>
   </button>
   <button type="button" className="mention-close" aria-label="关闭引用" title="关闭引用 · Esc" onClick={dismiss}>
    <Glyph name="close" size={14}/>
   </button>
  </div>
  <div className="mention-columns">
   <div className="mention-categories" ref={categories} role="group" aria-label="引用分类">
    {visibleMentionCategories(allOptions).map(group=><button key={group.kind} type="button"
     data-category={group.kind} aria-pressed={group.kind===category}
     onClick={()=>{onCategory(group.kind);onFocusInput();}}>
     <Glyph name={categoryGlyphs[group.kind]} size={15}/><span>{group.label}</span>
    </button>)}
    <TabSelectionIndicator selection={category} selector='button[aria-pressed="true"]'/>
   </div>
   <div className="mention-result-pane">
    {error&&<div className="mention-error">
     <span role="status" title={error}>{error}</span>
     <button type="button" onClick={()=>{onReload();onFocusInput();}}>重试</button>
    </div>}
    <div className="mention-results" id="composer-mention-options" ref={list} role="listbox" aria-label="引用候选" aria-busy={loading}>
     {options.map((option,i)=>{
      const type=mentionTypeLabel(option);
      return <button key={`${option.kind}:${option.id}`} id={mentionOptionId(option)} tabIndex={-1} type="button"
       role="option" aria-selected={i===index} aria-label={`${option.name}，${type}`}
       aria-describedby={i===index?"composer-mention-detail":undefined} className="mention-item"
       onPointerEnter={event=>activate(event,i)} onPointerMove={event=>activate(event,i)} onClick={()=>onSelect(option)}>
       {option.kind==="role"?<RoleMentionAvatar id={option.id} name={option.name} size={18}/>
        :option.kind==="resource"?<ResourceIcon kind={option.fromJumpServer?"jumpserver":option.resourceKind??"ssh"} size={16}/>
        :<Glyph name={option.kind==="skill"?"book":"plug"} size={16}/>}
       <span className="mention-name" title={option.name}>{option.name}</span>
       <span className="mention-kind">{type}</span>
      </button>;
     })}
     {!options.length&&<p className="mention-empty" role="status">
      {loading?"正在加载…":emptyMessages[category]??"没有匹配的引用"}
     </p>}
    </div>
    <div className="mention-detail" id="composer-mention-detail" title={activeDetail}>{activeDetail}</div>
   </div>
  </div>
  <div className="mention-footer">
   <div className="mention-shortcuts" aria-hidden="true">
    <span className="mention-category-shortcut"><kbd>←</kbd><kbd>→</kbd> 分类</span>
    <span className="mention-move-shortcut"><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
    <span><kbd>Tab</kbd><kbd>↵</kbd> 引用</span>
   </div>
   {(category==="all"||category==="resource")&&<button type="button" onClick={onImport}>
    <Glyph name="plus" size={13}/>导入资源
   </button>}
  </div>
 </div>;
}
