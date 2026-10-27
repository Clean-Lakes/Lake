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

export function PilotHeaderState({model,status,normal,onInspect,details,compact=false}:{compact?:boolean;details?:{available:boolean;open:boolean;toggle:()=>void};model:PilotIslandModel|null;status?:WorkSession['status'];normal:ReactNode;onInspect:(target:string)=>void}){
 const retained=useRef<PilotIslandModel|null>(model);if(model)retained.current=model;
 return <div className="header-state-area">
  <HeaderMorphSlot visible={!model||compact} className="header-normal-state">{normal}{details?.available&&<button type="button" className="header-inspector-toggle" aria-label={details.open?'收起执行详情':'展开执行详情'} title={details.open?'收起执行详情':'展开执行详情'} aria-controls={sessionInspectorId} aria-expanded={details.open} onClick={details.toggle}><Glyph name="chevron" size={13}/></button>}</HeaderMorphSlot>
  <HeaderMorphSlot visible={!!model&&!compact} className="header-pilot-state">{retained.current&&<PilotStatusIsland model={retained.current} status={status} visible={!!model&&!compact} onInspect={onInspect}/>}</HeaderMorphSlot>
 </div>;
}
