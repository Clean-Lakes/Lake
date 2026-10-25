import {useEffect,useLayoutEffect,useRef,type ReactNode} from 'react';
import type {QueuePresence} from './queuePresence';

export function queueMotionEnabled(){return typeof document!=='undefined'&&!document.hidden&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches;}

export function QueueMessagePresence({id,phase,onSettled,children}:{id:string;phase:QueuePresence['phase'];onSettled:(id:string,phase:QueuePresence['phase'])=>void;children:ReactNode}) {
 const element=useRef<HTMLLIElement>(null);
 const motion=useRef<Animation|null>(null);
 useLayoutEffect(()=>{
  const node=element.current;
  if(!node)return;
  // Read the painted state before cancelling: a fast add/remove can reverse
  // an in-flight transition without jumping to its full intrinsic height.
  const height=node.getBoundingClientRect().height;
  const opacity=getComputedStyle(node).opacity;
  const interrupted=!!motion.current;
  motion.current?.cancel();motion.current=null;
  if(phase==='present')return;
  if(!queueMotionEnabled()||!node.animate){onSettled(id,phase);return;}
  const target=node.getBoundingClientRect().height;
  const entering=phase==='entering';
  const animation=node.animate([
   {height:interrupted?`${height}px`:entering?'0px':`${target}px`,opacity:interrupted?opacity:entering?0:1,transform:entering?'translateY(8px)':'translateY(0)',overflow:'hidden'},
   {height:entering?`${target}px`:'0px',opacity:entering?1:0,transform:entering?'translateY(0)':'translateY(4px)',overflow:'hidden'},
  ],{duration:entering?260:200,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'});
  motion.current=animation;
  animation.onfinish=()=>{if(motion.current===animation)onSettled(id,phase);};
 },[id,phase,onSettled]);
 useEffect(()=>()=>{motion.current?.cancel();},[]);
 return <li ref={element} className="pending-message-presence" data-queue-presence={phase} aria-hidden={phase==='leaving'?true:undefined} inert={phase==='leaving'}>{children}</li>;
}
