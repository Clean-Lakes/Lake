import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {TabSelectionIndicator} from "./TabSelectionIndicator";
import {Glyph} from './Icons';
import type {Message} from '../../shared/contracts';
import {PilotTaskDirectory,type PilotTaskDirectoryData} from './PilotTaskDirectory';

export type ConversationDirectoryItem = {id:string;number:number;label:string;summary?:string};
export function conversationDirectoryItems(messages:Message[],visibleIds:Set<string>,summaries:ReadonlyMap<string,string>=new Map()):ConversationDirectoryItem[] {
 return messages.filter(message=>message.role==='user').map((message,index)=>({
  id:message.id,number:index+1,label:message.text.replace(/\s+/g,' ').trim()||'图片或附件',
  ...(summaries.get(message.id)?{summary:summaries.get(message.id)}:{}),
 })).filter(item=>visibleIds.has(item.id));
}
export function conversationTurnId(sessionId:string,entryId:string) {
 return `conversation-turn-${encodeURIComponent(sessionId)}-${encodeURIComponent(entryId)}`;
}
export function activeDirectoryItem(positions:{id:string;top:number}[],viewportTop:number) {
 return positions.filter(item=>item.top<=viewportTop+32).at(-1)?.id??positions[0]?.id??null;
}

function directoryItemAtScrollPosition(container: HTMLElement, items: ConversationDirectoryItem[], sessionId: string) {
 const positions = items.flatMap(({id}) => {
  const turn = document.getElementById(conversationTurnId(sessionId, id));
  return turn ? [{id, top: turn.getBoundingClientRect().top}] : [];
 });
 const padding = Number.parseFloat(getComputedStyle(container).scrollPaddingTop) || 0;
 return activeDirectoryItem(positions, container.getBoundingClientRect().top + padding);
}

export function ConversationDirectory({sessionId,items,onJump,onLatest,onLoadOlder,loading=false,taskDirectory}:{
 sessionId:string;items:ConversationDirectoryItem[];onJump:(id:string)=>void;onLatest:()=>void;
 onLoadOlder?:()=>void;loading?:boolean;taskDirectory?:PilotTaskDirectoryData;
}) {
 const [open,setOpen]=useState(false),[selected,setSelected]=useState<string|null>(items[0]?.id??null);
 const [view,setView]=useState<'tasks'|'messages'>('tasks');
 const showTasks=!!taskDirectory&&view==='tasks';
 const [position,setPosition]=useState({left:12,top:80,width:360});
 const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLElement>(null),list=useRef<HTMLElement>(null);
 const root=useRef<HTMLDivElement>(null);
 const rows=useRef(new Map<string,HTMLButtonElement>()),id=useId();
 const itemIds=JSON.stringify(items.map(item=>item.id));
 function close(restoreFocus=false){setOpen(false);if(restoreFocus)trigger.current?.focus({preventScroll:true});}
 function toggle() {
  if (open) { close(); return; }
  setView(taskDirectory?'tasks':'messages');
  const container = document.querySelector<HTMLElement>('.conversation');
  if (container&&!taskDirectory) setSelected(directoryItemAtScrollPosition(container, items, sessionId));
  setOpen(true);
 }
 useLayoutEffect(()=>{
  const container=document.querySelector<HTMLElement>('.conversation');if(!container)return;
  let frame=0,header:HTMLElement|null=null;
  function update(){
   const nextHeader=header?.isConnected?header:document.querySelector<HTMLElement>('.island-conversation, .workspace > .workspace-header');
   if(nextHeader!==header){
    if(header)observer.unobserve(header);
    headerObserver.disconnect();header=nextHeader;
    if(header){observer.observe(header);headerObserver.observe(header,{attributes:true,attributeFilter:['class','style','data-ready','data-present']});}
   }
   const bounds=container!.getBoundingClientRect(),heading=header?.getBoundingClientRect();
   let left=Math.max(bounds.left+4,bounds.right-76),top=Math.max(bounds.top+12,(heading?.top??bounds.top)+9);
   if(heading&&container!.closest('.has-docked-conversation')){
    const style=getComputedStyle(container!);
    const actionsOffset=parseFloat(style.getPropertyValue('--conversation-header-actions-offset'));
    left=Math.max(bounds.left+4,bounds.right-actionsOffset);
    top=heading.top+Math.max(0,(heading.height-(trigger.current?.offsetHeight??28))/2);
   }
   const compact=!!heading&&left<heading.right+8&&left+64>heading.left;
   if(compact){left=bounds.left+2;top=Math.max(bounds.top+12,heading!.bottom+10);}
   if(open&&!showTasks)setSelected(directoryItemAtScrollPosition(container!,items,sessionId));
   if(root.current){
    const nextLeft=`${left}px`,nextTop=`${top}px`;
    const moved=root.current.style.left!==nextLeft||root.current.style.top!==nextTop;
    root.current.style.left=nextLeft;root.current.style.top=nextTop;root.current.toggleAttribute('data-compact',compact);
    if(moved)window.dispatchEvent(new Event('lake-chrome-resize'));
   }
  }
  function schedule(){cancelAnimationFrame(frame);frame=requestAnimationFrame(update);}
  const observer=new ResizeObserver(schedule),headerObserver=new MutationObserver(schedule);
  observer.observe(container);update();
  const content=open&&!showTasks&&container.querySelector('.timeline-list');if(content)observer.observe(content);
  if(open&&!showTasks)container.addEventListener('scroll',schedule,{passive:true});
  window.addEventListener('resize',schedule);
  return()=>{cancelAnimationFrame(frame);observer.disconnect();headerObserver.disconnect();container.removeEventListener('scroll',schedule);window.removeEventListener('resize',schedule);};
 },[sessionId,itemIds,open,showTasks]);
 useLayoutEffect(()=>{
  if(!open)return;
  function measure(){
   const anchor=trigger.current?.getBoundingClientRect();if(!anchor)return;
   const width=Math.min(360,window.innerWidth-24),height=panel.current?.getBoundingClientRect().height??240;
   const left=Math.max(12,Math.min(anchor.left,window.innerWidth-width-12));
   const below=anchor.bottom+6;
   const top=below+height<=window.innerHeight-12?below:Math.max(12,anchor.top-height-6);
   setPosition(previous=>previous.left===left&&previous.top===top&&previous.width===width?previous:{left,top,width});
  }
  measure();const observer=new ResizeObserver(measure);if(panel.current)observer.observe(panel.current);
  window.addEventListener('resize',measure);document.addEventListener('scroll',measure,true);
  return()=>{observer.disconnect();window.removeEventListener('resize',measure);document.removeEventListener('scroll',measure,true);};
 },[open]);
 useLayoutEffect(()=>{
  if(!open)return;
  if(taskDirectory)panel.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.focus({preventScroll:true});
  if(showTasks)return;
  const row=rows.current.get(selected??'')??rows.current.get(items[0]?.id??'');
  if(!taskDirectory)row?.focus({preventScroll:true});
  if(row&&list.current)list.current.scrollTop=row.offsetTop-list.current.clientHeight/2;
 },[open,showTasks,!!taskDirectory]);
 useEffect(()=>{
  if(!open)return;
  function outside(event:Event){const target=event.target as Node;if(!trigger.current?.contains(target)&&!panel.current?.contains(target))close();}
  function escape(event:KeyboardEvent){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}}
  document.addEventListener('pointerdown',outside);document.addEventListener('focusin',outside);document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('focusin',outside);document.removeEventListener('keydown',escape);};
 },[open]);
 if(!taskDirectory&&items.length<2&&!onLoadOlder)return null;
 const tabs=taskDirectory&&<div role="tablist" aria-label="目录视图" className="conversation-directory-tabs"
  onKeyDown={event=>{
   if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
   event.preventDefault();
   const next=event.key==='Home'?'tasks':event.key==='End'?'messages':showTasks?'messages':'tasks';
   setView(next);
   document.getElementById(`${id}-${next}-tab`)?.focus({preventScroll:true});
  }}>
  <button type="button" role="tab" id={`${id}-tasks-tab`} aria-controls={`${id}-tasks`} aria-selected={showTasks} tabIndex={showTasks?0:-1} onClick={()=>setView('tasks')}>任务</button>
  <button type="button" role="tab" id={`${id}-messages-tab`} aria-controls={`${id}-messages`} aria-selected={!showTasks} tabIndex={showTasks?-1:0} onClick={()=>setView('messages')}>消息</button>
  <TabSelectionIndicator selection={showTasks}/>
 </div>;
 const content=open&&<section ref={panel} className="conversation-directory-popover" style={position} id={id} role="dialog" aria-label="会话目录">
  <header className="conversation-directory-heading">{tabs||<span>当前对话</span>}<button type="button" aria-label="关闭会话目录" onClick={()=>close(true)}><Glyph name="close" size={15}/></button></header>
  {taskDirectory&&<div id={`${id}-tasks`} role="tabpanel" aria-labelledby={`${id}-tasks-tab`} className="conversation-directory-view" hidden={!showTasks}>
   {showTasks&&<PilotTaskDirectory data={taskDirectory} visibleSources={new Set(items.map(item=>item.id))}
    onContinue={task=>{close();taskDirectory.onContinue(task);}} onLocate={source=>{onJump(source);close(true);}}/>}
  </div>}
  <div className="conversation-directory-view" id={taskDirectory?`${id}-messages`:undefined} role={taskDirectory?'tabpanel':undefined} aria-labelledby={taskDirectory?`${id}-messages-tab`:undefined} hidden={showTasks}>
  <nav className="conversation-directory-list" aria-label="会话提问" ref={list}>
   {items.map((item,index)=><button type="button" key={item.id} ref={node=>{if(node)rows.current.set(item.id,node);else rows.current.delete(item.id);}}
    className="conversation-directory-item" aria-current={selected===item.id?'location':undefined} title={item.label}
    onClick={()=>{onJump(item.id);close(true);}} onKeyDown={event=>{
     const next=event.key==='ArrowDown'?Math.min(items.length-1,index+1):event.key==='ArrowUp'?Math.max(0,index-1):event.key==='Home'?0:event.key==='End'?items.length-1:-1;
     if(next<0)return;event.preventDefault();const row=rows.current.get(items[next]!.id);row?.focus({preventScroll:true});row?.scrollIntoView({block:'nearest'});
    }}>
    <span className="conversation-directory-number" aria-hidden="true">{item.number}</span><span className="conversation-directory-label">{item.label}</span>
   </button>)}
  </nav>
  <footer className="conversation-directory-actions">
   {onLoadOlder&&<button type="button" disabled={loading} onClick={onLoadOlder}>{loading?'正在加载…':'加载更早记录'}</button>}
   <button type="button" onClick={()=>{onLatest();close(true);}}>回到最新</button>
  </footer>
  </div>
 </section>;
 const navigation=<div className={`conversation-directory${open?' is-open':''}`} ref={root}>
  <button ref={trigger} type="button" className="conversation-directory-trigger" aria-label="会话目录" title="会话目录" aria-haspopup="dialog" aria-expanded={open} aria-controls={open?id:undefined} onClick={toggle}><Glyph name="listTasks" size={15}/><span>目录</span></button>
  {content}
 </div>;
 return typeof document==='undefined'?navigation:createPortal(navigation,document.body);
}
