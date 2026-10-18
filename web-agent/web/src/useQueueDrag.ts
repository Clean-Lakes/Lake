import {useEffect,useLayoutEffect,useRef,useState,type PointerEvent} from "react";
import {queueDropAt,queueDragScroll,type QueueDrop} from "./queueDrag";

type Options={ids:string[];revision:number;disabled:boolean;onMove:(id:string,position:number)=>void;onStale:()=>void};
type Drag={id:string;pointer:number;startX:number;startY:number;x:number;y:number;active:boolean;revision:number;ids:string[];handle:HTMLButtonElement};

export function useQueueDrag(options:Options) {
 const list=useRef<HTMLOListElement>(null);
 const current=useRef(options);
 const drag=useRef<Drag|null>(null);
 const frame=useRef(0);
 const [dragging,setDragging]=useState<string|null>(null);
 const [drop,setDrop]=useState<QueueDrop|null>(null);
 useLayoutEffect(()=>{current.current=options;});
 useEffect(()=>()=>{cancelAnimationFrame(frame.current);drag.current=null;},[]);
 function stop() {
  const previous=drag.current;
  drag.current=null;
  cancelAnimationFrame(frame.current);
  setDragging(null);setDrop(null);
  if(previous?.handle.hasPointerCapture(previous.pointer))previous.handle.releasePointerCapture(previous.pointer);
 }
 function stale(value:Drag) {
  const latest=current.current;
  return latest.disabled || latest.revision!==value.revision || latest.ids.join("\0")!==value.ids.join("\0");
 }
 function target(value:Drag) {
  const element=list.current;
  if(!element)return null;
  const bounds=element.getBoundingClientRect();
  if(value.x<bounds.left-32 || value.x>bounds.right+32 || value.y<bounds.top-40 || value.y>bounds.bottom+40)return null;
  const rows=[...element.querySelectorAll<HTMLElement>('[data-queue-id]')].map(row=>{
   const rect=row.getBoundingClientRect();return {id:row.dataset.queueId!,top:rect.top,bottom:rect.bottom};
  });
  return queueDropAt(rows,value.id,value.y);
 }
 function tick() {
  const value=drag.current;
  if(!value?.active)return;
  if(stale(value)){stop();current.current.onStale();return;}
  const element=list.current;
  if(element){
   const bounds=element.getBoundingClientRect();
   if(value.x>=bounds.left-32 && value.x<=bounds.right+32 && value.y>=bounds.top-40 && value.y<=bounds.bottom+40)element.scrollTop+=queueDragScroll(value.y,bounds.top,bounds.bottom);
  }
  const next=target(value);
  setDrop(previous=>previous?.id===next?.id&&previous?.edge===next?.edge&&previous?.position===next?.position?previous:next);
  frame.current=requestAnimationFrame(tick);
 }
 function start(event:PointerEvent<HTMLButtonElement>,id:string) {
  if(current.current.disabled || drag.current || event.button!==0)return;
  event.preventDefault();
  event.currentTarget.focus({preventScroll:true});
  event.currentTarget.setPointerCapture(event.pointerId);
  drag.current={id,pointer:event.pointerId,startX:event.clientX,startY:event.clientY,x:event.clientX,y:event.clientY,active:false,revision:current.current.revision,ids:[...current.current.ids],handle:event.currentTarget};
 }
 function update(event:PointerEvent<HTMLButtonElement>) {
  const value=drag.current;
  if(!value || value.pointer!==event.pointerId)return;
  value.x=event.clientX;value.y=event.clientY;
  if(!value.active && Math.hypot(value.x-value.startX,value.y-value.startY)>=4){value.active=true;setDragging(value.id);tick();}
 }
 function finish(event:PointerEvent<HTMLButtonElement>) {
  const value=drag.current;
  if(!value || value.pointer!==event.pointerId)return;
  value.x=event.clientX;value.y=event.clientY;
  const changed=stale(value);
  const next=value.active?target(value):null;
  stop();
  if(changed){current.current.onStale();return;}
  if(next)current.current.onMove(value.id,next.position);
 }
 return {list,dragging,drop,start,update,finish,cancel:stop};
}
