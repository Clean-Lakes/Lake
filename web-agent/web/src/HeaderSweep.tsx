import {useEffect,useRef,useState} from 'react';
import {usePageVisible} from './usePageVisible';
import {useSynchronizedLight} from './synchronizedLight';

export const HEADER_SWEEP_FADE_MS=700;

/** Keep the same layer frozen during exit; resumed light rejoins the shared phase. */
export function HeaderSweep({active}:{active:boolean}) {
 const visible=usePageVisible();
 const sweep=useRef<HTMLSpanElement>(null);
 useSynchronizedLight(sweep,active&&visible);
 const [retained,setRetained]=useState(active);
 useEffect(()=>{
  if(active){setRetained(true);return;}
  if(!retained)return;
  const timer=window.setTimeout(()=>setRetained(false),HEADER_SWEEP_FADE_MS);
  return ()=>window.clearTimeout(timer);
 },[active,retained]);
 if(!active&&!retained)return null;
 return <span ref={sweep} className={`workspace-header-sweep${active?'':' is-receding'}`} style={{transitionDuration:`${HEADER_SWEEP_FADE_MS}ms`}} aria-hidden="true"><span className="header-sweep-light" style={{animationPlayState:active&&visible?'running':'paused'}}/></span>;
}
