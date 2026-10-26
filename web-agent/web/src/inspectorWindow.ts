import {useLayoutEffect,useRef} from 'react';

declare global {interface Window {lakeInspectorWindow?:{setOpen:(open:boolean)=>Promise<{addedWidth:number}>};}}

/** Native macOS grows the window. Hold the original canvas through that animation. */
export function useInspectorWindow(open:boolean){
 const revision=useRef(0),requested=useRef(false);
 useLayoutEffect(()=>{
  const bridge=window.lakeInspectorWindow;
  const workspace=document.querySelector<HTMLElement>('.workspace');
  if(!bridge||!workspace||!open&&!requested.current)return;
  requested.current=open;
  const version=++revision.current;
  const width=workspace.getBoundingClientRect().width;
  const held=parseFloat(workspace.style.getPropertyValue('--inspector-main-width'));
  const base=workspace.classList.contains('inspector-window-sizing')&&Number.isFinite(held)?held:open?width:Math.max(0,width-382);
  workspace.style.setProperty('--inspector-main-width',`${base}px`);
  workspace.classList.add('inspector-window-sizing');
  void bridge.setOpen(open).catch(()=>undefined).finally(()=>{
   if(revision.current!==version)return;
   workspace.classList.remove('inspector-window-sizing');
   workspace.style.removeProperty('--inspector-main-width');
  });
 },[open]);
 useLayoutEffect(()=>()=>{revision.current++;if(requested.current)void window.lakeInspectorWindow?.setOpen(false).catch(()=>{});},[]);
}
