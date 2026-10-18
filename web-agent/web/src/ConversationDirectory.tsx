import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {Glyph} from "./Icons";
import {remarkAssistantProse} from "./assistantProse";
import {remarkConversationExcerpt} from './conversationPreview';
import type { Message } from "../../shared/contracts";

export type ConversationDirectoryItem = { id: string; number: number; label: string; summary?:string };
export function conversationDirectoryItems(messages: Message[], visibleIds: Set<string>, summaries:ReadonlyMap<string,string>=new Map()): ConversationDirectoryItem[] {
  return messages.filter(message => message.role === "user").map((message, index) => ({
    id: message.id, number: index + 1, label: message.text.replace(/\s+/g, " ").trim() || "图片或附件",
    ...(summaries.get(message.id)?{summary:summaries.get(message.id)}:{}),
  })).filter(item => visibleIds.has(item.id));
}
export function conversationTurnId(sessionId: string, entryId: string) {
  return `conversation-turn-${encodeURIComponent(sessionId)}-${encodeURIComponent(entryId)}`;
}

export function activeDirectoryItem(positions: {id: string; top: number}[], viewportTop: number) {
  return positions.filter(item => item.top <= viewportTop + 32).at(-1)?.id ?? positions[0]?.id ?? null;
}

export function ConversationDirectory({sessionId, items, onJump, onLatest, onOpen, onLoadOlder, loading = false}: {
  sessionId: string;
  items: ConversationDirectoryItem[]; onJump: (id: string) => void; onLatest: () => void;
  onOpen?: () => void; onLoadOlder?: () => void; loading?: boolean;
}) {
  const [previewId,setPreviewId]=useState<string|null>(null);
  const [selected, setSelected] = useState<string | null>(items[0]?.id ?? null);
  const [position,setPosition]=useState({left:40,top:80,width:360});
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const marks=useRef(new Map<string,HTMLButtonElement>());
  const lastTrigger=useRef<HTMLButtonElement|null>(null);
  const suppressFocus=useRef(false);
  const panelId = useId();
  const hintId = `${panelId}-hint`;
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const itemIds = JSON.stringify(items.map(item => item.id));
  const railHeight = Math.max(28, Math.min(400, items.length * 10 + 12));
  const preview=items.find(item=>item.id===previewId);
  function close(restoreFocus=false){clearTimeout(leaveTimer.current);setPreviewId(null);if(restoreFocus){suppressFocus.current=true;lastTrigger.current?.focus({preventScroll:true});suppressFocus.current=false}}
  function show(id:string){clearTimeout(leaveTimer.current);lastTrigger.current=marks.current.get(id)??null;setPreviewId(id)}
  function leavePreview(){clearTimeout(leaveTimer.current);leaveTimer.current=setTimeout(()=>{if(!panel.current?.contains(document.activeElement))setPreviewId(null)},160)}
  function jump(item:ConversationDirectoryItem){onJump(item.id);setSelected(item.id);close()}
  useEffect(()=>()=>clearTimeout(leaveTimer.current),[]);
  useLayoutEffect(() => {
    const container = document.querySelector<HTMLElement>(".conversation");
    if (!container) return;
    let frame = 0;
    function update() {
      const bounds = container!.getBoundingClientRect();
      root.current?.style.setProperty("--directory-center-top", `${bounds.top + bounds.height / 2}px`);
      const timeline = container!.querySelector<HTMLElement>(".timeline-list");
      if (timeline) {
        const narrow = window.matchMedia("(max-width: 700px)").matches;
        const configuredGutter = Number.parseFloat(getComputedStyle(container!).getPropertyValue("--session-gutter"));
        const gutter = configuredGutter || (narrow ? 32 : 40);
        const margin = narrow ? 4 - gutter : 8 - Math.max(gutter, (container!.clientWidth - 960) / 2);
        root.current?.style.setProperty("--directory-center-left", `${timeline.getBoundingClientRect().left + margin}px`);
      }
      const positions = items.flatMap(item => {
        const turn = document.getElementById(conversationTurnId(sessionId, item.id));
        return turn ? [{id: item.id, top: turn.getBoundingClientRect().top}] : [];
      });
      setSelected(activeDirectoryItem(positions, container!.getBoundingClientRect().top));
    }
    function schedule() {cancelAnimationFrame(frame);frame=requestAnimationFrame(update);}
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    const content = container.querySelector(".timeline-list");
    if(content)observer.observe(content);
    container.addEventListener("scroll",schedule);
    window.addEventListener("resize",schedule);
    return()=>{cancelAnimationFrame(frame);observer.disconnect();container.removeEventListener("scroll",schedule);window.removeEventListener("resize",schedule);};
  }, [sessionId, itemIds]);
  useLayoutEffect(()=>{
    if(!preview)return;
    function measure(){
      const anchor=marks.current.get(preview!.id)?.getBoundingClientRect();
      if(!anchor)return;
      const bounds=document.querySelector<HTMLElement>('.conversation')?.getBoundingClientRect();
      const right=Math.min(window.innerWidth-12,bounds?.right??window.innerWidth-12);
      const left=Math.max(12,Math.min(anchor.right+12,right-160));
      const width=Math.max(120,Math.min(360,right-left));
      const height=panel.current?.getBoundingClientRect().height??180;
      const top=Math.max(12,Math.min(anchor.top+anchor.height/2-height/2,window.innerHeight-height-12));
      setPosition(old=>old.left===left&&old.top===top&&old.width===width?old:{left,top,width});
    }
    measure();
    const observer=new ResizeObserver(measure);
    if(panel.current)observer.observe(panel.current);
    window.addEventListener('resize',measure);
    document.addEventListener('scroll',measure,true);
    return()=>{observer.disconnect();window.removeEventListener('resize',measure);document.removeEventListener('scroll',measure,true)};
  },[previewId,preview?.summary]);
  useEffect(()=>{
    if(!previewId)return;
    function outside(event:PointerEvent){if(!root.current?.contains(event.target as Node))close()}
    function escape(event:KeyboardEvent){if(event.key==='Escape'){event.preventDefault();close(true)}}
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape)};
  },[previewId]);
  const content=<div className="conversation-directory" ref={root} style={{"--directory-rail-height":`${railHeight}px`,"--directory-count":Math.max(1,items.length)} as CSSProperties}
    onPointerEnter={()=>clearTimeout(leaveTimer.current)} onPointerLeave={leavePreview}
    onFocusCapture={()=>clearTimeout(leaveTimer.current)} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node)&&!event.currentTarget.matches(':hover'))leavePreview()}}>
    <nav className="conversation-directory-marks" aria-label="会话目录">{items.map((item,index)=><button type="button" key={item.id} ref={node=>{if(node)marks.current.set(item.id,node);else marks.current.delete(item.id)}}
      className={`conversation-directory-tick${selected===item.id?' is-current':''}${previewId===item.id?' is-previewed':''}`} data-directory-item={item.id}
      aria-label={`跳转到第 ${item.number} 轮：${item.label}`} aria-current={selected===item.id?'location':undefined} aria-describedby={hintId} aria-expanded={previewId===item.id} aria-controls={previewId===item.id?panelId:undefined}
      tabIndex={selected===item.id||!selected&&index===0?0:-1}
      onPointerEnter={event=>{if(event.pointerType!=='touch')show(item.id)}} onFocus={()=>{if(!suppressFocus.current)show(item.id)}} onClick={()=>jump(item)}
      onKeyDown={event=>{const next=event.key==='ArrowDown'?Math.min(items.length-1,index+1):event.key==='ArrowUp'?Math.max(0,index-1):event.key==='Home'?0:event.key==='End'?items.length-1:-1;if(next>=0){event.preventDefault();marks.current.get(items[next]!.id)?.focus({preventScroll:true})}}}>
      <span className="conversation-directory-mark" aria-hidden="true"/>
    </button>)}</nav>
    <span className="visually-hidden" id={hintId}>悬停预览这一轮的提问与回复，点击刻度跳转。完整记录保留。</span>
    {preview&&<section ref={panel} className="conversation-turn-preview" style={position} id={panelId} aria-label={`第 ${preview.number} 轮预览`}>
      <button className="conversation-turn-preview-title" type="button" onClick={()=>jump(preview)}><strong>{preview.label}</strong><Glyph name="arrow" size={15}/></button>
      <div className="conversation-turn-preview-body"><Markdown remarkPlugins={[remarkGfm,remarkAssistantProse,remarkConversationExcerpt]} skipHtml allowedElements={['p','strong','em','ul','ol','li','code','del']} unwrapDisallowed>{preview.summary||'暂无回复'}</Markdown></div>
      {onLoadOlder&&<button type="button" className="conversation-directory-older" disabled={loading} onClick={()=>{onOpen?.();onLoadOlder()}}>{loading?'正在加载…':'加载更早记录'}</button>}
      <button type="button" className="conversation-directory-latest" onClick={()=>{onLatest();close()}}>跳到最新</button>
    </section>}
  </div>;
  return typeof document==='undefined'?content:createPortal(content,document.body);
}
