import {useLayoutEffect,useRef} from 'react';

/** Reveal a newly identified line without replacing its DOM node or changing
 * layout. Text/status updates on the same line never restart the motion. */
export function useLineArrival(identity:string|undefined,enabled:boolean,animateInitial=false) {
 const element=useRef<HTMLSpanElement>(null);
 const previous=useRef<string|undefined>(identity);
 const mounted=useRef(false);
 const animation=useRef<Animation|null>(null);
 useLayoutEffect(()=>{
  const initial=!mounted.current;
  mounted.current=true;
  const changed=previous.current!==identity;
  previous.current=identity;
  if(!changed&&!(initial&&animateInitial))return;
  animation.current?.cancel();
  const node=element.current;
  if(!node||typeof node.animate!=='function'||!identity||!enabled||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  animation.current=node.animate([
   {opacity:0,transform:'translateY(23px)'},
   {opacity:1,transform:'translateY(0)'},
  ],{duration:360,easing:'cubic-bezier(.22,1,.36,1)'});
 },[identity,enabled,animateInitial]);
 useLayoutEffect(()=>{
  const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
  const stop=()=>{if(motion.matches)animation.current?.cancel()};
  motion.addEventListener('change',stop);
  return()=>{motion.removeEventListener('change',stop);animation.current?.cancel()};
 },[]);
 return element;
}
