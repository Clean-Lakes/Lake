import {useEffect,useRef,useState} from 'react';
import {TextReveal} from './textReveal';

export function useSmoothText(text:string,streaming:boolean,animateInitial=false){
 const [shown,setShown]=useState(streaming&&animateInitial?'':text);
 const displayed=useRef(shown);displayed.current=shown;
 const latest=useRef({text,streaming});latest.current={text,streaming};
 const sync=useRef<()=>void>(()=>{});
 useEffect(()=>{
  if(!streaming)return;
  const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
  const engine=new TextReveal(displayed.current,setShown);
  sync.current=()=>engine.update(latest.current.text,latest.current.streaming&&!motion.matches&&!document.hidden);
  motion.addEventListener('change',sync.current);document.addEventListener('visibilitychange',sync.current);
  sync.current();
  return()=>{engine.stop();motion.removeEventListener('change',sync.current);document.removeEventListener('visibilitychange',sync.current);sync.current=()=>{}};
 },[streaming]);
 useEffect(()=>sync.current(),[text,streaming]);
 // Completion, cancellation and replacement are visible in the same render,
 // including SSR. Frames never delay approvals, errors, or a final response.
 return !streaming||!text.startsWith(shown)?text:shown;
}
