import {useCallback,useLayoutEffect,useRef} from 'react';

declare global {interface Window {lakeInspectorWindow?:{setOpen:(open:boolean)=>Promise<{addedWidth:number}>};}}

/** Native macOS grows the window. Hold the visible conversation through that animation. */
export function useInspectorWindow(open:boolean){
 const revision=useRef(0),requested=useRef(false);
 const view=useRef<HTMLDivElement|null>(null);
 const settled=useRef<{width:number;docked:boolean}|null>(null);
 const measure=useCallback(()=>{
  const element=view.current;
  const workspace=element?.closest('.workspace');
  if(!element||!workspace||workspace.classList.contains('inspector-window-sizing'))return;
  const inspector=workspace.querySelector('.session-inspector.is-open');
  const docked=inspector?getComputedStyle(inspector).position==='relative':!window.matchMedia('(max-width:1100px)').matches;
  const width=element.getBoundingClientRect().width;
  if(width>0)settled.current={width,docked};
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
  requested.current=open;
  const version=++revision.current;
  const layout=settled.current;
  if(layout){
   workspace.style.setProperty('--inspector-main-width',`${layout.width}px`);
   workspace.classList.add('inspector-window-sizing');
   workspace.classList.toggle('inspector-window-docked',layout.docked);
  }
  void bridge.setOpen(open).catch(()=>undefined).finally(()=>{
   if(revision.current!==version)return;
   workspace.classList.remove('inspector-window-sizing','inspector-window-docked');
   workspace.style.removeProperty('--inspector-main-width');
   measure();
  });
 },[open,measure]);
 useLayoutEffect(()=>()=>{revision.current++;if(requested.current)void window.lakeInspectorWindow?.setOpen(false).catch(()=>{});},[]);
 return attachView;
}
