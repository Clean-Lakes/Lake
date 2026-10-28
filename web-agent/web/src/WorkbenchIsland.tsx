import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import './workbenchIsland.css';
import {workbenchIslandLayout,type IslandPosition} from './workbenchIslandLayout';

export function useWideWorkbench(){
 const [wide,setWide]=useState(()=>matchMedia('(min-width:1101px)').matches);
 useEffect(()=>{const query=matchMedia('(min-width:1101px)');const update=()=>setWide(query.matches);update();query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);
 return wide;
}

type IslandBox=IslandPosition&{top:number};
type IslandFlight={open?:boolean;target?:IslandBox;animation?:Animation;deadline?:number};
const sameBox=(a:IslandBox|undefined,b:IslandBox)=>!!a&&Math.abs(a.left-b.left)<.5&&Math.abs(a.top-b.top)<.5&&Math.abs(a.width-b.width)<.5;

/** Auxiliary islands separate from the conversation and land over their own panes. */
export function WorkbenchIsland({conversation,terminal,activity,inspectorOpen,terminalOpen,onInspectorHost}:{conversation:ReactNode;terminal:ReactNode;activity:ReactNode;inspectorOpen:boolean;terminalOpen:boolean;onInspectorHost:(node:HTMLDivElement|null)=>void}){
 const root=useRef<HTMLDivElement>(null),conversationIsland=useRef<HTMLDivElement>(null),inspectorIsland=useRef<HTMLDivElement>(null),terminalIsland=useRef<HTMLDivElement>(null);
 const open=useRef({inspector:inspectorOpen,terminal:terminalOpen});
 open.current={inspector:inspectorOpen,terminal:terminalOpen};
 const scheduleLayout=useRef<()=>void>(()=>{});
 useLayoutEffect(()=>{
  const element=root.current,shell=element?.closest<HTMLElement>('.app-shell'),identity=conversationIsland.current;
  if(!element||!shell||!identity)return;
  let frame=0;
  const reduced=matchMedia('(prefers-reduced-motion:reduce)');
  const flights:Record<'inspector'|'terminal',IslandFlight>={inspector:{},terminal:{}};
  const observed=new Set<Element>();
  const write=(node:HTMLElement,box:IslandBox)=>{node.style.left=`${box.left}px`;node.style.top=`${box.top}px`;node.style.width=`${box.width}px`;};
  const present=(node:HTMLElement,value:boolean)=>{node.dataset.present=String(value);node.dataset.ready='true';};
  const move=(name:'inspector'|'terminal',node:HTMLElement,goal:IslandBox|undefined,source:IslandBox,base:DOMRect)=>{
   const flight=flights[name],expanded=open.current[name],changed=flight.open!==expanded;
   if(!expanded&&flight.open===undefined){flight.open=false;present(node,false);return;}
   if(!expanded&&!flight.open&&!flight.animation)return;
   const target=expanded?goal:source;
   if(!target)return;
   if(reduced.matches||document.documentElement.classList.contains('workbench-resizing')){
    flight.animation?.cancel();flight.animation=undefined;flight.open=expanded;flight.target=target;write(node,target);present(node,expanded);delete node.dataset.moving;return;
   }
   if(!changed&&!flight.animation){write(node,target);flight.target=target;present(node,expanded);return;}
   if(!changed&&sameBox(flight.target,target))return;
   const bounds=node.getBoundingClientRect();
   const from=expanded&&!flight.animation&&changed?source:{left:bounds.left-base.left,top:bounds.top-base.top,width:bounds.width};
   const opacity=expanded&&!flight.animation&&changed ? .15 : Number(getComputedStyle(node).opacity);
   flight.animation?.cancel();
   if(changed)flight.deadline=performance.now()+(expanded?380:280);
   const duration=Math.max(1,(flight.deadline??performance.now())-performance.now());
   flight.open=expanded;flight.target=target;
   write(node,target);present(node,true);node.dataset.moving='true';
   const animation=node.animate([
    {left:`${from.left}px`,top:`${from.top}px`,width:`${from.width}px`,opacity},
    {left:`${target.left}px`,top:`${target.top}px`,width:`${target.width}px`,opacity:expanded?1:0},
   ],{duration,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'});
   flight.animation=animation;
   animation.onfinish=()=>{if(flight.animation!==animation)return;flight.animation=undefined;present(node,expanded);delete node.dataset.moving;animation.cancel();window.dispatchEvent(new Event('lake-chrome-resize'));};
  };
  const measure=()=>{
   frame=0;
   const view=shell.querySelector<HTMLElement>('.session-layout > .session-view');
   if(!view)return;
   const bounds=view.getBoundingClientRect(),base=shell.getBoundingClientRect();
   const composer=view.querySelector('.composer-input')?.getBoundingClientRect();
   const available=Math.max(1,composer?.width??bounds.width-96),left=(composer?.left??bounds.left+48)-base.left;
   shell.style.setProperty('--pane-rail-bottom',`${Math.max(12,base.bottom-(composer?.top??base.bottom)+12)}px`);
   const title=identity.querySelector<HTMLElement>('.crumb-title'),state=identity.querySelector<HTMLElement>('.header-morph-slot.is-visible .header-morph-content');
   const heading=inspectorIsland.current?.querySelector<HTMLElement>('.island-inspector-heading');
   const terminalHeader=terminalIsland.current?.querySelector<HTMLElement>('.terminal-panel-header');
   const terminalLabel=terminalHeader?.querySelector<HTMLElement>('.terminal-island-title');
   const terminalNumber=terminalHeader?.querySelector<HTMLElement>('.terminal-island-number');
   const terminalCount=terminalHeader?.querySelector<HTMLElement>('.terminal-island-count');
   const inspectorPane=shell.querySelector('.session-inspector.is-open')?.getBoundingClientRect();
   const terminalPane=open.current.terminal?shell.querySelector('.terminal-side-panel')?.getBoundingClientRect():undefined;
   const layout=workbenchIslandLayout({
    conversation:{left,width:available,inset:0},
    inspector:inspectorPane?{left:inspectorPane.left-base.left,width:inspectorPane.width}:undefined,
    terminal:terminalPane?{left:terminalPane.left-base.left,width:terminalPane.width}:undefined,
    conversationWidth:Math.min(190,title?.scrollWidth??160)+(state?.getBoundingClientRect().width??0)+60,
    inspectorWidth:Math.max(144,heading?.scrollWidth??144),
    terminalWidth:Math.min(320,(terminalLabel?.scrollWidth??120)+(terminalNumber?.offsetWidth??0)+(terminalCount?.offsetWidth??0)+112),
   });
   const top=shell.closest('html.lake-windows-chrome')?52:12;
   const source={...layout.conversation,top};
   write(identity,source);identity.dataset.ready='true';identity.dataset.present='true';identity.title=title?.textContent??'';
   if(inspectorIsland.current)move('inspector',inspectorIsland.current,layout.inspector?{...layout.inspector,top}:undefined,source,base);
   if(terminalIsland.current)move('terminal',terminalIsland.current,layout.terminal?{...layout.terminal,top}:undefined,source,base);
   const candidates=new Set<Element>([shell,identity,...shell.querySelectorAll('.workspace,.session-layout > .session-view,.session-inspector,.terminal-side-panel,.composer-input,.composer-dock,.header-morph-content,.crumb-title,.island-inspector-heading,.terminal-island-title')]);
   for(const node of observed)if(!candidates.has(node)){observer.unobserve(node);observed.delete(node);}
   for(const node of candidates)if(!observed.has(node)){observed.add(node);observer.observe(node);}
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(measure);};
  scheduleLayout.current=schedule;
  const observer=new ResizeObserver(schedule);
  const content=new MutationObserver(schedule);
  content.observe(shell,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class']});
  window.addEventListener('resize',schedule);reduced.addEventListener('change',schedule);measure();
  return()=>{scheduleLayout.current=()=>{};content.disconnect();observer.disconnect();cancelAnimationFrame(frame);window.removeEventListener('resize',schedule);reduced.removeEventListener('change',schedule);for(const flight of Object.values(flights))flight.animation?.cancel();shell.style.removeProperty('--pane-rail-bottom');};
 },[]);
 useLayoutEffect(()=>scheduleLayout.current(),[inspectorOpen,terminalOpen]);
 return <div ref={root} className="lake-workbench-islands" role="group" aria-label="Lake Island 工作台">
  <div ref={conversationIsland} className="lake-workbench-island island-conversation"><span className="workspace-header-glass" aria-hidden="true"/>{activity}{conversation}</div>
  <div ref={inspectorIsland} className="lake-workbench-island island-inspector" data-open={inspectorOpen} inert={!inspectorOpen} aria-hidden={!inspectorOpen}><span className="workspace-header-glass" aria-hidden="true"/><div ref={onInspectorHost} className="island-inspector-content"/></div>
  <div ref={terminalIsland} className="lake-workbench-island island-terminal" data-open={terminalOpen} inert={!terminalOpen} aria-hidden={!terminalOpen}><span className="workspace-header-glass" aria-hidden="true"/>{terminal}</div>
 </div>;
}
