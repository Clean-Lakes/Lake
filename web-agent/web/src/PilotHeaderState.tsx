import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import type {PilotIslandModel} from './pilotIslandModel';
import {PilotStatusIsland} from './PilotStatusIsland';

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

export function PilotHeaderState({model,normal,onInspect}:{model:PilotIslandModel|null;normal:ReactNode;onInspect:(target:string)=>void}){
 const retained=useRef<PilotIslandModel|null>(model);if(model)retained.current=model;
 return <div className="header-state-area">
  <HeaderMorphSlot visible={!model} className="header-normal-state">{normal}</HeaderMorphSlot>
  <HeaderMorphSlot visible={!!model} className="header-pilot-state">{retained.current&&<PilotStatusIsland model={retained.current} visible={!!model} onInspect={onInspect}/>}</HeaderMorphSlot>
 </div>;
}
