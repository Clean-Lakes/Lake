import {useCallback,useId,useLayoutEffect,useRef,useState,type ReactNode,type PointerEvent} from 'react';
import {sidebarScrollFromThumb,sidebarScrollGeometry} from './sidebarScroll';

export function SidebarScrollArea({children}:{children:ReactNode}){
 const id=useId();
 const viewport=useRef<HTMLElement>(null),content=useRef<HTMLDivElement>(null);
 const drag=useRef<{pointer:number;y:number;top:number;travel:number;range:number}|null>(null);
 const hideTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const [visible,setVisible]=useState(false);
 const reveal=useCallback(()=>{
  setVisible(true);
  if(hideTimer.current)clearTimeout(hideTimer.current);
  hideTimer.current=setTimeout(()=>{hideTimer.current=null;if(!drag.current)setVisible(false);},1000);
 },[]);
 const [geometry,setGeometry]=useState({...sidebarScrollGeometry(0,0,0),position:0,page:0});
 useLayoutEffect(()=>{
  const box=viewport.current,body=content.current;if(!box||!body)return;
  let frame=0;
  const measure=()=>{
   const metrics=sidebarScrollGeometry(box.clientHeight,box.scrollHeight,box.scrollTop);
   const next={...metrics,position:Math.max(0,Math.min(metrics.range,box.scrollTop)),page:box.clientHeight};
   setGeometry(old=>Object.keys(next).every(key=>old[key as keyof typeof old]===next[key as keyof typeof next])?old:next);
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;measure();});};
  // Scroll already arrives before paint; another animation frame here makes
  // the overlay trail behind native scrolling and pointer dragging.
  const onScroll=()=>{measure();reveal();};
  const observer=new ResizeObserver(schedule);observer.observe(box);observer.observe(body);
  box.addEventListener('scroll',onScroll,{passive:true});measure();
  return()=>{observer.disconnect();box.removeEventListener('scroll',onScroll);if(frame)cancelAnimationFrame(frame);if(hideTimer.current)clearTimeout(hideTimer.current);};
 },[reveal]);
 function finish(event:PointerEvent<HTMLButtonElement>){
  if(drag.current?.pointer!==event.pointerId)return;
  drag.current=null;
  reveal();
  if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
 }
 return <div className="sidebar-scroll-area" onPointerEnter={reveal} onPointerMove={event=>{
  if(event.pointerType==='touch')return;
  const edge=event.currentTarget.getBoundingClientRect().right;
  if(event.clientX>=edge-14)reveal();
 }}>
  <nav id={id} className="project-scroll" ref={viewport}><div ref={content}>{children}</div></nav>
  {geometry.thumb>0&&<button type="button" className={`sidebar-scroll-thumb${visible?' is-visible':''}`} role="scrollbar" aria-label="滚动项目导航" aria-controls={id} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={Math.round(geometry.range)} aria-valuenow={Math.round(geometry.position)} style={{transform:`translateY(${geometry.top+4}px)`,height:geometry.thumb}} onFocus={reveal} onPointerDown={event=>{
   if(event.button!==0)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
   reveal();
   drag.current={pointer:event.pointerId,y:event.clientY,top:geometry.top,travel:geometry.travel,range:geometry.range};
  }} onPointerMove={event=>{
   const active=drag.current;if(!active||active.pointer!==event.pointerId||!viewport.current)return;
   viewport.current.scrollTop=sidebarScrollFromThumb(active.top+event.clientY-active.y,active.travel,active.range);
  }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={()=>{drag.current=null;reveal();}} onKeyDown={event=>{
   const box=viewport.current;if(!box)return;
   const change:Record<string,number>={ArrowUp:-40,ArrowDown:40,PageUp:-geometry.page*.8,PageDown:geometry.page*.8,Home:-geometry.range,End:geometry.range};
   if(!(event.key in change))return;event.preventDefault();box.scrollTop+=change[event.key]!;
  }}/>}
 </div>;
}
