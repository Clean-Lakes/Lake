import {useEffect,useState} from 'react';

export const HEADER_SWEEP_FADE_MS=700;

/** Keep the same moving layer alive during its exit, including a quick resume. */
export function HeaderSweep({active}:{active:boolean}) {
 const [retained,setRetained]=useState(active);
 useEffect(()=>{
  if(active){setRetained(true);return;}
  if(!retained)return;
  const timer=window.setTimeout(()=>setRetained(false),HEADER_SWEEP_FADE_MS);
  return ()=>window.clearTimeout(timer);
 },[active,retained]);
 if(!active&&!retained)return null;
 return <span className={`workspace-header-sweep${active?'':' is-receding'}`} style={{transitionDuration:`${HEADER_SWEEP_FADE_MS}ms`}} aria-hidden="true"><span className="header-sweep-light"/></span>;
}
