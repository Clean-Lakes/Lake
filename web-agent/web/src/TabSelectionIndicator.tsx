import {useLayoutEffect,useRef} from "react";
import {alignSelectionIndicator,cancelSelectionMotion,type SelectionAxis} from "./selectionMotion";

/** Paint the selection with the shared spring without moving or re-rendering buttons. */
export function TabSelectionIndicator({
  selection,
  selector='[role="tab"][aria-selected="true"]',
  axis='both',
  className='',
}:{
  selection:string|boolean|null|undefined;
  selector?:string;
  axis?:SelectionAxis;
  className?:string;
}) {
  const indicator=useRef<HTMLSpanElement>(null);
  useLayoutEffect(()=>{
    const line=indicator.current;
    return()=>{if(line)cancelSelectionMotion(line);};
  },[]);
  useLayoutEffect(()=>{
    const line=indicator.current;
    const list=line?.parentElement;
    if(!line||!list)return;
    const target=()=>list.querySelector<HTMLElement>(selector);
    const sync=(animate:boolean)=>{
      alignSelectionIndicator(list,line,target(),{axis,animate,key:String(selection??'')});
    };
    sync(true);
    const resize=new ResizeObserver(()=>sync(false));
    resize.observe(list);
    for(const child of list.children){
      if(child!==line&&child instanceof HTMLElement)resize.observe(child);
    }
    return()=>resize.disconnect();
  },[selection,selector,axis]);
  return <span ref={indicator} className={className?`tab-selection-indicator ${className}`:"tab-selection-indicator"} data-axis={axis} aria-hidden="true"/>;
}
