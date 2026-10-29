import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import type {WorkSession} from '../../shared/contracts';
import type {PilotIslandModel} from './pilotIslandModel';
import {PilotStatusIsland} from './PilotStatusIsland';
import {Glyph} from './Icons';
import {sessionInspectorId} from './SessionInspectorContext';

// Both alternatives stay measured. The glass bubble follows their interpolated
// widths; the title and conversation remain in place during a mode change.
function HeaderMorphSlot({visible,children,className=''}:{visible:boolean;children:ReactNode;className?:string}){
 const content=useRef<HTMLDivElement>(null);
 const [width,setWidth]=useState<number>();
 useLayoutEffect(()=>{
  const element=content.current;if(!element)return;
  const measure=()=>{const next=element.getBoundingClientRect().width;setWidth(old=>old===next?old:next)};
  measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
 },[]);
 return <div className={`header-morph-slot ${className}${visible?' is-visible':''}`} style={{width:visible?width:0}} aria-hidden={!visible} inert={!visible}><div ref={content} className="header-morph-content">{children}</div></div>;
}

export function PilotHeaderState({model,mode,status,normal,onInspect,details}:{details?:{available:boolean;open:boolean;toggle:()=>void};model:PilotIslandModel|null;mode?:'auto'|'manual';status?:WorkSession['status'];normal:ReactNode;onInspect:(target:string)=>void}){
 const retained=useRef<PilotIslandModel|null>(model);if(model)retained.current=model;
 const pilotVisible=!!model||!!mode;
 const inspectorToggle=details?.available&&<button type="button" className="header-inspector-toggle" aria-label={details.open?'收起执行详情':'展开执行详情'} title={details.open?'收起执行详情':'展开执行详情'} aria-controls={sessionInspectorId} aria-expanded={details.open} onClick={details.toggle}><Glyph name="next" size={13}/></button>;
 return <div className="header-state-area">
  <HeaderMorphSlot visible={!pilotVisible} className="header-normal-state">{normal}{inspectorToggle}</HeaderMorphSlot>
  <HeaderMorphSlot visible={pilotVisible} className="header-pilot-state">{!model&&mode?<div className="pilot-mode-entry" role="group" aria-label={`Lake Pilot 已开启 · ${mode==='auto'?'自动推进':'手动选择'} · 本轮没有专员任务`}>
   <Glyph name="lakePilot" size={20}/><span className="pilot-mode-copy"><strong>Lake Pilot</strong><small>{mode==='auto'?'自动推进':'手动选择'}</small></span>{normal}{inspectorToggle}
  </div>:retained.current&&<PilotStatusIsland model={retained.current} status={status} visible={!!model} onInspect={onInspect}/>}</HeaderMorphSlot>
 </div>;
}
