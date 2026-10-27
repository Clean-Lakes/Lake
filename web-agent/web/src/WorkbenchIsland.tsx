import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import './workbenchIsland.css';
import {workbenchIslandLayout} from './workbenchIslandLayout';

export function useWideWorkbench(){
 const [wide,setWide]=useState(()=>matchMedia('(min-width:1101px)').matches);
 useEffect(()=>{const query=matchMedia('(min-width:1101px)');const update=()=>setWide(query.matches);update();query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);
 return wide;
}

/** One surface, with controls aligned to the real panes rather than guessed widths. */
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
   const inspector=shell.querySelector('.session-inspector.is-open')?.getBoundingClientRect();
   const terminal=shell.querySelector('.terminal-side-panel.is-open')?.getBoundingClientRect();
   const inspectorWidth=inspectorOpen&&inspector?inspector.width:0;
   const terminalWidth=terminalOpen&&terminal?terminal.width:0;
   const linked=inspectorWidth>0||terminalWidth>0;
   element.style.left=`${left-base.left}px`;
   element.style.maxWidth=`${Math.max(120,base.right-left-16)}px`;
   const layout=workbenchIslandLayout(bounds.right-left,inspectorWidth,terminalWidth);
   const title=element.querySelector<HTMLElement>('.crumb-title');
   const state=element.querySelector<HTMLElement>('.header-morph-slot.is-visible .header-morph-content');
   const natural=(title?.scrollWidth??160)+(state?.getBoundingClientRect().width??0)+62;
   element.style.width=`${linked?layout.width:Math.min(Math.max(160,natural),Math.max(160,bounds.right-left-16))}px`;
   element.style.gridTemplateColumns=linked?layout.columns.map(width=>`minmax(0,${width}px)`).join(' '):'minmax(0,1fr)';
   element.dataset.ready='true';
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(measure);};
  const observer=new ResizeObserver(schedule);
  for(const node of [element,shell,shell.querySelector('.workspace'),shell.querySelector('.session-layout > .session-view'),shell.querySelector('.session-inspector'),shell.querySelector('.terminal-side-panel')])if(node)observer.observe(node);
  for(const node of element.querySelectorAll('.header-morph-slot,.header-morph-content,.crumb-title'))observer.observe(node);
  window.addEventListener('resize',schedule);measure();
  return()=>{observer.disconnect();cancelAnimationFrame(frame);window.removeEventListener('resize',schedule);};
 },[inspectorOpen,terminalOpen]);
 return <div ref={root} className="lake-workbench-island" data-linked={inspectorOpen||terminalOpen} role="group" aria-label="Lake Island 工作台">
  <span className="workspace-header-glass" aria-hidden="true"/>
  {activity}
  <div className="island-conversation">{conversation}</div>
  <div ref={onInspectorHost} className="island-inspector" hidden={!inspectorOpen}/>
  <div className="island-terminal" hidden={!terminalOpen}>{terminal}</div>
 </div>;
}
