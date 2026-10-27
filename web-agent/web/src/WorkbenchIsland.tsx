import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import './workbenchIsland.css';
import {workbenchIslandLayout} from './workbenchIslandLayout';

export function useWideWorkbench(){
 const [wide,setWide]=useState(()=>matchMedia('(min-width:1101px)').matches);
 useEffect(()=>{const query=matchMedia('(min-width:1101px)');const update=()=>setWide(query.matches);update();query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);
 return wide;
}

/** A compact shared island: pane widths never stretch the space between controls. */
export function WorkbenchIsland({conversation,terminal,activity,inspectorOpen,terminalOpen,onInspectorHost}:{conversation:ReactNode;terminal:ReactNode;activity:ReactNode;inspectorOpen:boolean;terminalOpen:boolean;onInspectorHost:(node:HTMLDivElement|null)=>void}){
 const root=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{
  const element=root.current,shell=element?.closest('.app-shell');
  if(!element||!shell)return;
  let frame=0;
  const measure=()=>{
   frame=0;
   const view=shell.querySelector<HTMLElement>('.session-layout > .session-view');
   if(!view)return;
   const bounds=view.getBoundingClientRect(),base=shell.getBoundingClientRect();
   const transcript=view.querySelector('.timeline-list')?.getBoundingClientRect();
   const left=Math.min(bounds.right-120,Math.max(bounds.left+16,transcript?.left??bounds.left+48));
   const title=element.querySelector<HTMLElement>('.crumb-title');
   const state=element.querySelector<HTMLElement>('.header-morph-slot.is-visible .header-morph-content');
   const inspector=element.querySelector<HTMLElement>('.island-inspector-heading');
   const terminal=element.querySelector<HTMLElement>('.terminal-panel-header');
   const available=Math.max(160,base.right-left-16);
   const natural=Math.min(190,title?.scrollWidth??160)+(state?.getBoundingClientRect().width??0)+60;
   const layout=workbenchIslandLayout(natural,inspectorOpen?inspector?.scrollWidth??220:0,terminalOpen?terminal?.scrollWidth??220:0,available);
   element.style.left=`${left-base.left}px`;
   element.style.maxWidth=`${available}px`;
   element.style.width=`${layout.width}px`;
   element.style.gridTemplateColumns=layout.columns.map(width=>`minmax(0,${width}px)`).join(' ');
   element.dataset.ready='true';
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(measure);};
  const observer=new ResizeObserver(schedule);
  for(const node of [element,shell,shell.querySelector('.workspace'),shell.querySelector('.session-layout > .session-view'),shell.querySelector('.session-inspector'),shell.querySelector('.terminal-side-panel')])if(node)observer.observe(node);
  const observeControls=()=>{for(const node of element.querySelectorAll('.header-morph-slot,.header-morph-content,.crumb-title,.island-inspector-heading,.terminal-panel-header,.terminal-header-actions'))observer.observe(node);};
  observeControls();
  const content=new MutationObserver(()=>{observeControls();schedule();});
  content.observe(element,{childList:true,subtree:true,characterData:true});
  window.addEventListener('resize',schedule);measure();
  return()=>{content.disconnect();observer.disconnect();cancelAnimationFrame(frame);window.removeEventListener('resize',schedule);};
 },[inspectorOpen,terminalOpen]);
 return <div ref={root} className="lake-workbench-island" data-linked={inspectorOpen||terminalOpen} role="group" aria-label="Lake Island 工作台">
  <span className="workspace-header-glass" aria-hidden="true"/>
  {activity}
  <div className="island-conversation">{conversation}</div>
  <div ref={onInspectorHost} className="island-inspector" hidden={!inspectorOpen}/>
  <div className="island-terminal" hidden={!terminalOpen}>{terminal}</div>
 </div>;
}
