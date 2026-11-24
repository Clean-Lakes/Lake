import {useCallback,useLayoutEffect,useRef,useState} from 'react';
import {inspectorExitMs,retainConversation,useSessionInspector} from './SessionInspectorContext';

declare global {interface Window {lakeInspectorWindow?:{setOpen:(open:boolean)=>Promise<{addedWidth:number;viewportWidth?:number}>};}}

/** Keep the conversation in place until WKWebView receives the final window bounds. */
export function useInspectorWindow(open:boolean){
 const requested=useRef(false);
 const [ready,setReady]=useState(false);
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
  const layout=settled.current;
  if(layout){
   workspace.style.setProperty('--inspector-main-width',`${layout.width}px`);
   if(layout.readingWidth)workspace.style.setProperty('--inspector-reading-width',`${layout.readingWidth}px`);
   workspace.classList.add('inspector-window-sizing');
   workspace.classList.toggle('inspector-window-docked',layout.docked);
  }
  let active=true,frame=0,timer=0;
  const settle=()=>{
   if(!active)return;
   const restore=retainConversation();
   workspace.classList.remove('inspector-window-sizing','inspector-window-docked');
   workspace.style.removeProperty('--inspector-main-width');
   workspace.style.removeProperty('--inspector-reading-width');
   window.dispatchEvent(new Event('lake-workbench-layout'));
   restore();
   measure();
   if(open)setReady(true);
   else frame=requestAnimationFrame(()=>focusOpener?.(true));
  };
  const waitForViewport=(width?:number)=>{
   if(!active)return;
   if(document.hidden){settle();return;}
   // The native reply can arrive before WebKit has applied the new viewport.
   // Keep a short fallback for an independent window resize racing the request.
   const deadline=performance.now()+100;
   const paint=(now:number)=>{
    if(width&&Math.abs(innerWidth-width)>1&&now<deadline){frame=requestAnimationFrame(paint);return;}
    settle();
   };
   frame=requestAnimationFrame(paint);
  };
  const request=()=>{
   if(!open)setReady(false);
   requested.current=open;
   void bridge.setOpen(open).then(result=>waitForViewport(result.viewportWidth),()=>waitForViewport());
  };
  if(!open&&!document.hidden&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&workspace.querySelector('.session-inspector.is-closing')){
   timer=window.setTimeout(request,inspectorExitMs);
  }else request();
  return()=>{active=false;cancelAnimationFrame(frame);window.clearTimeout(timer);};
 },[open,measure,focusOpener]);
 useLayoutEffect(()=>()=>{if(requested.current)void window.lakeInspectorWindow?.setOpen(false).catch(()=>{});},[]);
 return {attachView,waitingForWindow:open&&!!window.lakeInspectorWindow&&!ready};
}
