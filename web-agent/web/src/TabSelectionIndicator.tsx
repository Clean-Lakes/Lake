import {useLayoutEffect,useRef} from "react";

/** Paint the selection without moving or re-rendering the tab buttons. */
export function TabSelectionIndicator({selection}:{selection:string|boolean}) {
  const indicator=useRef<HTMLSpanElement>(null);
  useLayoutEffect(()=>{
    const line=indicator.current;
    const list=line?.parentElement;
    if(!line||!list)return;
    const tab=list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if(!tab)return;
    const place=()=>{
      line.style.setProperty("--tab-selection-left",`${tab.offsetLeft}px`);
      line.style.setProperty("--tab-selection-top",`${tab.offsetTop}px`);
      line.style.setProperty("--tab-selection-width",`${tab.offsetWidth}px`);
      line.style.setProperty("--tab-selection-height",`${tab.offsetHeight}px`);
      line.dataset.ready="true";
    };
    place();
    const resize=new ResizeObserver(place);
    resize.observe(list);
    // A preceding label can resize without changing the selected label's width.
    for(const button of list.querySelectorAll('[role="tab"]'))resize.observe(button);
    return()=>resize.disconnect();
  },[selection]);
  return <span ref={indicator} className="tab-selection-indicator" aria-hidden="true"/>;
}
