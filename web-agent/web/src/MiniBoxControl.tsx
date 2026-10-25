import {useEffect,useRef} from 'react';

// One persistent CSS clock per Mini Box; output and status refreshes do not
// recreate it. The control layer never captures clicks or covers the session.
export function MiniBoxControl({active}:{active:boolean}) {
 const ref=useRef<HTMLSpanElement>(null);
 useEffect(()=>{
  const sync=()=>{if(ref.current)ref.current.dataset.suspended=String(document.hidden);};
  sync();document.addEventListener('visibilitychange',sync);
  return()=>document.removeEventListener('visibilitychange',sync);
 },[]);
 return <span ref={ref} className="mini-box-control" data-active={active} aria-hidden="true"><span className="mini-box-control-flow"/></span>;
}
