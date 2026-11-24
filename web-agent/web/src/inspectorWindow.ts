import {useCallback,useLayoutEffect,useRef,useState} from 'react';
import {flushSync} from 'react-dom';
import {inspectorExitMs,retainConversation,useSessionInspector} from './SessionInspectorContext';

type InspectorWindowSize={addedWidth:number;viewportWidth?:number};
type InspectorWindowPlan={id:number;pinnedViewportWidth?:number};
declare global {interface Window {lakeInspectorWindow?:{
 setOpen:(open:boolean)=>Promise<InspectorWindowSize>;
 prepare?:(open:boolean,width:number,docked:boolean)=>Promise<InspectorWindowPlan>;
 animate?:(id:number,animate:boolean)=>Promise<InspectorWindowSize>;
};}}

/** Keep the reading layout fixed while the native viewport reveals the right pane. */
export function useInspectorWindow(open:boolean){
 const requested=useRef(false);
 const [ready,setReady]=useState(false);
 const [nativePresence,setNativePresence]=useState<boolean>();
 const nativeReveal=useRef(false);
 const focusOpener=useSessionInspector()?.focusOpener;
 const view=useRef<HTMLDivElement|null>(null);
 const settled=useRef<{width:number;readingWidth?:number;docked:boolean}|null>(null);
 const measure=useCallback(()=>{
  const element=view.current;
  const workspace=element?.closest('.workspace');
  if(!element||!workspace||workspace.classList.contains('inspector-window-sizing'))return;
  const inspector=workspace.querySelector('.session-inspector.is-open');
  const docked=inspector?getComputedStyle(inspector).position==='relative':window.matchMedia('(min-width:960px)').matches;
  const width=element.getBoundingClientRect().width;
  const reading=element.querySelector('.composer-input')??element.querySelector('.timeline-list');
  if(width>0)settled.current={width,readingWidth:reading?.getBoundingClientRect().width,docked};
 },[]);
 const attachView=useCallback((element:HTMLDivElement|null)=>{
  if(!element||!window.lakeInspectorWindow)return;
  view.current=element;
  measure();
  const observer=new ResizeObserver(measure);
  observer.observe(element);
  observer.observe(document.documentElement);
  return()=>{observer.disconnect();view.current=null;};
 },[measure]);
 useLayoutEffect(()=>{
  const bridge=window.lakeInspectorWindow;
  const workspace=document.querySelector<HTMLElement>('.workspace');
  if(!bridge||!workspace||!open&&!requested.current)return;
  const shell=workspace.closest<HTMLElement>('.app-shell');
  const layout=settled.current;
  if(layout&&(open||!bridge.prepare||nativeReveal.current)){
   workspace.style.setProperty('--inspector-main-width',`${layout.width}px`);
   if(layout.readingWidth)workspace.style.setProperty('--inspector-reading-width',`${layout.readingWidth}px`);
   workspace.classList.add('inspector-window-sizing');
   workspace.classList.toggle('inspector-window-docked',layout.docked);
  }
  let active=true,frame=0,timer=0;
  const canAnimate=!document.hidden&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
  const settle=()=>{
   if(!active)return;
   const restore=retainConversation();
   if(!open&&nativeReveal.current){
    // The pane is outside the restored frame. Remove it before releasing the frozen layout.
    flushSync(()=>setNativePresence(false));
    nativeReveal.current=false;
   }
   workspace.classList.remove('inspector-window-sizing','inspector-window-docked','inspector-window-pinned');
   workspace.style.removeProperty('--inspector-main-width');
   workspace.style.removeProperty('--inspector-reading-width');
   window.dispatchEvent(new Event('lake-workbench-layout'));
   restore();
   measure();
   if(open)flushSync(()=>setReady(true));
   else {
    requested.current=false;
    setReady(false);
    frame=requestAnimationFrame(()=>focusOpener?.(true));
   }
  };
  const waitForViewport=(width:number|undefined,next=settle)=>{
   if(!active)return;
   if(document.hidden){next();return;}
   // The native reply can arrive before WebKit has applied the new viewport.
   // Keep a short fallback for an independent window resize racing the request.
   const deadline=performance.now()+100;
   const paint=(now:number)=>{
    if(width&&Math.abs(innerWidth-width)>1&&now<deadline){frame=requestAnimationFrame(paint);return;}
    next();
   };
   frame=requestAnimationFrame(paint);
  };
  const legacy=()=>bridge.setOpen(open).then(result=>waitForViewport(result.viewportWidth),settle);
  const request=(run:()=>Promise<unknown>)=>{
   if(!open&&!nativeReveal.current&&canAnimate&&workspace.querySelector('.session-inspector.is-closing')){
    timer=window.setTimeout(()=>{void run();},inspectorExitMs);
   }else void run();
  };
  if(open)requested.current=true;
  if(!bridge.prepare||!bridge.animate||!shell)request(legacy);
  else {
   const animate=bridge.animate;
   const requestedWidth=parseFloat(getComputedStyle(shell).getPropertyValue('--inspector-requested-width'))||382;
   const docked=!!layout?.docked&&!shell.classList.contains('terminal-is-open');
   void bridge.prepare(open,requestedWidth,docked).then(plan=>{
    if(!active)return;
    const run=(motion:boolean)=>animate(plan.id,motion).then(result=>waitForViewport(result.viewportWidth),()=>{
     if(active)return legacy();
    });
    if(!plan.pinnedViewportWidth||!layout||!workspace.querySelector('.session-inspector')){
     if(open&&!nativeReveal.current)setNativePresence(undefined);
     request(()=>run(false));
     return;
    }
    // The host clips a fully laid-out viewport. Paint the card beside the
    // frozen chat before letting the window uncover either surface.
    workspace.classList.add('inspector-window-pinned');
    nativeReveal.current=true;
    setNativePresence(true);
    waitForViewport(plan.pinnedViewportWidth,()=>{
     window.dispatchEvent(new Event('lake-workbench-layout'));
     if(document.hidden){void run(false);return;}
     frame=requestAnimationFrame(()=>{if(active)void run(canAnimate);});
    });
   },()=>{if(active)request(legacy);});
  }
  return()=>{active=false;cancelAnimationFrame(frame);window.clearTimeout(timer);};
 },[open,measure,focusOpener]);
 useLayoutEffect(()=>()=>{if(requested.current)void window.lakeInspectorWindow?.setOpen(false).catch(()=>{});},[]);
 return {attachView,waitingForWindow:open&&!!window.lakeInspectorWindow&&!ready,nativePresence};
}
