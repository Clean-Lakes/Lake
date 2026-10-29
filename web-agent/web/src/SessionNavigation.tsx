import {useRef,useState,type DragEvent,type ReactNode} from 'react';
import type {WorkSession} from '../../shared/contracts';
import {Glyph} from './Icons';
import {readableError} from './api';
import {sidebarSessions} from './sidebarState';
import {sessionDropBefore,sortSessionNavigation} from './sessionNavigationModel';
import {queueDragScroll} from './queueDrag';
import './sessionNavigation.css';

type Drop={pinned:boolean;beforeId:string|null;row?:string;after?:boolean};
export function SessionNavigation({sessions,selectedId,showAll,bulkMode,disabled,renderSession,onMove,onShowAll}:{sessions:WorkSession[];selectedId:string|null;showAll:boolean;bulkMode:boolean;disabled:boolean;renderSession:(session:WorkSession)=>ReactNode;onMove:(session:WorkSession,pinned:boolean,beforeId:string|null)=>Promise<void>;onShowAll:()=>void}){
 const root=useRef<HTMLDivElement>(null);
 const [announcement,setAnnouncement]=useState('');
 const [dragging,setDragging]=useState<string|null>(null),[drop,setDrop]=useState<Drop|null>(null),[error,setError]=useState('');
 const source=useRef<WorkSession|null>(null);
 const sorted=sortSessionNavigation(sessions),pinned=sorted.filter(s=>s.pinned),ordinary=sorted.filter(s=>!s.pinned);
 const cancel=()=>{source.current=null;setDragging(null);setDrop(null);};
 async function move(session:WorkSession,target:Drop){
  if(disabled||bulkMode)return;
  setError('');
  try{await onMove(session,target.pinned,target.beforeId);setAnnouncement(`${session.title}：${!!session.pinned!==target.pinned?target.pinned?'已置顶':'已取消置顶':'顺序已保存'}`);requestAnimationFrame(()=>{
   const row=[...(root.current?.querySelectorAll<HTMLElement>('[data-session-nav-id]')??[])].find(row=>row.dataset.sessionNavId===session.id);row?.querySelector<HTMLButtonElement>('.session-drag-handle')?.focus({preventScroll:true});
  });}
  catch(error){setError(readableError(error));}
 }
 function allow(event:DragEvent){
  if(!source.current||disabled||bulkMode)return false;
  event.preventDefault();event.dataTransfer.dropEffect='move';
  const scroll=event.currentTarget.closest<HTMLElement>('.project-scroll');
  if(scroll){const box=scroll.getBoundingClientRect();scroll.scrollTop+=queueDragScroll(event.clientY,box.top,box.bottom);}
  return true;
 }
 function commit(event:DragEvent,target:Drop){
  if(!allow(event))return;event.stopPropagation();
  const session=source.current;cancel();if(session)void move(session,target);
 }
 function group(isPinned:boolean,all:WorkSession[],visible:WorkSession[]){
  const title=isPinned?'置顶':showAll?'全部会话':'最近会话';
  return <section className={`session-nav-group${isPinned&&!all.length?' is-empty-pin-drop':''}${drop?.pinned===isPinned&&!drop.row?' is-drop-group':''}`} aria-label={title} onDragOver={event=>{if(allow(event)){event.stopPropagation();setDrop({pinned:isPinned,beforeId:all[0]?.id??null});}}} onDrop={event=>commit(event,{pinned:isPinned,beforeId:all.find(s=>s.id!==source.current?.id)?.id??null})}>
   {!all.length&&!bulkMode&&<p className="session-nav-empty">{isPinned?'拖到这里置顶':'还没有会话'}</p>}
   {visible.map(session=><div key={session.id} data-session-nav-id={session.id} className={`session-sort-row${bulkMode?' is-bulk':''}${dragging===session.id?' is-dragging':''}${drop?.row===session.id?drop.after?' drop-after':' drop-before':''}`} onDragOver={event=>{
    if(!allow(event))return;event.stopPropagation();if(session.id===source.current?.id){setDrop(null);return;}
    const box=event.currentTarget.getBoundingClientRect(),after=event.clientY>=(box.top+box.bottom)/2;
    setDrop({pinned:isPinned,beforeId:sessionDropBefore(all,source.current!.id,session.id,after),row:session.id,after});
   }} onDrop={event=>{if(!source.current)return;if(source.current.id===session.id){event.preventDefault();event.stopPropagation();cancel();return;}const box=event.currentTarget.getBoundingClientRect(),after=event.clientY>=(box.top+box.bottom)/2;commit(event,{pinned:isPinned,beforeId:sessionDropBefore(all,source.current.id,session.id,after)});}}>
    {!bulkMode&&<button type="button" className="session-drag-handle" draggable={!disabled} disabled={disabled} aria-label={`拖动排序会话 ${session.title}`} title="拖动排序；上下方向键移动，左右方向键切换置顶" onClick={event=>event.stopPropagation()} onDragStart={event=>{
     if(disabled){event.preventDefault();return;}source.current=session;setDragging(session.id);setError('');event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-lake-session',session.id);
     const row=event.currentTarget.parentElement;if(row)event.dataTransfer.setDragImage(row,12,18);
    }} onDragEnd={cancel} onKeyDown={event=>{
     if(event.key==='Escape'){cancel();return;}
     if(disabled)return;const index=all.findIndex(s=>s.id===session.id);
     if(event.key==='ArrowLeft'&&!session.pinned||event.key==='ArrowRight'&&session.pinned){event.preventDefault();const target=session.pinned?ordinary:pinned;void move(session,{pinned:!session.pinned,beforeId:target[0]?.id??null});}
     if(event.key==='ArrowUp'&&index>0){event.preventDefault();void move(session,{pinned:isPinned,beforeId:all[index-1]!.id});}
     if(event.key==='ArrowDown'&&index<all.length-1){event.preventDefault();void move(session,{pinned:isPinned,beforeId:all[index+2]?.id??null});}
    }}><Glyph name="grip" size={12}/></button>}
    {renderSession(session)}
   </div>)}
  </section>;
 }
 return <div ref={root} className="session-navigation" aria-busy={disabled} onKeyDown={event=>{if(event.key==='Escape')cancel();}}>
  {(pinned.length>0||dragging&&!bulkMode)&&group(true,pinned,pinned)}
  {group(false,ordinary,sidebarSessions(ordinary,selectedId,showAll))}
  {ordinary.length>5&&<button type="button" className="nav-show-more" aria-expanded={showAll} onClick={onShowAll}>{showAll?'收起历史会话':`查看全部 ${ordinary.length} 个会话`}</button>}
  {error&&<p className="session-navigation-error" role="alert">{error}</p>}
  <span className="visually-hidden" role="status">{dragging?'正在移动会话':announcement}</span>
 </div>;
}
