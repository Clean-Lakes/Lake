import {useLayoutEffect,useRef,useState} from 'react';
import {firstGrapheme,TextReveal} from './textReveal';

export function useSmoothText(text:string,streaming:boolean,{animateInitial=false,finishPending=false}:{
 animateInitial?:boolean;finishPending?:boolean;
}={}){
 const [shown,setShown]=useState(()=>streaming&&animateInitial?firstGrapheme(text):text);
 const [playing,setPlaying]=useState(streaming);
 const hasPendingSuffix=shown.length<text.length&&text.startsWith(shown);
 // Success can arrive with the final packet still queued. Let the existing
 // clock finish its suffix, without starting playback for completed history.
 const play=streaming||finishPending&&playing&&hasPendingSuffix;
 if(playing!==play)setPlaying(play);
 if(!play&&shown!==text)setShown(text);
 const visible=play&&hasPendingSuffix?shown:text;
 const latest=useRef(text);
 useLayoutEffect(()=>{latest.current=text;},[text]);
 const sync=useRef<()=>void>(()=>{});
 useLayoutEffect(()=>{
  if(!play)return;
  const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
  const engine=new TextReveal(visible,setShown);
  sync.current=()=>engine.update(latest.current,!motion.matches&&!document.hidden);
  motion.addEventListener('change',sync.current);document.addEventListener('visibilitychange',sync.current);
  sync.current();
  return()=>{engine.stop();motion.removeEventListener('change',sync.current);document.removeEventListener('visibilitychange',sync.current);sync.current=()=>{}};
 },[play]);
 useLayoutEffect(()=>sync.current(),[text,play]);
 return visible;
}
