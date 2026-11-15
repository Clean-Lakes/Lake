import {useEffect,useRef,type CSSProperties,type ReactNode} from 'react';
import {LakeAvatarFigure,type LakeAvatarName} from './LakeAvatarFigure';
import {lakeAvatarThinking} from './lakeAvatarThinking';
import {createAnimalThinkingMotion,type AnimalThinkingMotion} from './animalThinkingMotion';
import {useSpecialistAppearance} from './SuperRoleAvatar';
import {usePageVisible} from './usePageVisible';

export type AnimalThinkingBubbleProps={name?:string;roleId?:string;avatarId?:LakeAvatarName;active?:boolean;identity?:ReactNode};

/** The caller opts in only for current model thinking, never queue/tool/wait states. */
export function AnimalThinkingBubble({name='',roleId,avatarId,active=true,identity}:AnimalThinkingBubbleProps){
 const look=useSpecialistAppearance({name,roleId,avatarId}),definition=lakeAvatarThinking[look.icon],visible=usePageVisible();
 const character=useRef<HTMLSpanElement>(null),motion=useRef<AnimalThinkingMotion|undefined>(undefined);
 const paused=!active||!visible;
 useEffect(()=>{
  const element=character.current;if(!element)return;
  const media=window.matchMedia('(prefers-reduced-motion: reduce)');
  const controller=createAnimalThinkingMotion(element,look.icon,{paused,reducedMotion:media.matches,phase:look.phase});
  motion.current=controller;
  const changed=()=>controller.setReducedMotion(media.matches);
  media.addEventListener('change',changed);
  return()=>{media.removeEventListener('change',changed);controller.dispose();if(motion.current===controller)motion.current=undefined;};
 },[look.icon,look.phase]);
 useEffect(()=>{motion.current?.setPaused(paused);},[paused]);
 const style={'--thinking-character-ground':`${28*definition.foot/64}px`} as CSSProperties;
 return <div className={`animal-thinking-bubble reply-process-text${identity?' has-identity':''}`} data-animal={look.icon} style={style}>
  <div className="animal-thinking-surface">
   <span ref={character} className="animal-thinking-character" data-side={definition.side} data-variant={look.variant} data-motion={active?'thinking':'still'} data-hidden={!visible||undefined} aria-hidden="true"><LakeAvatarFigure role={look.icon} size={28} className="animal-thinking-figure" thinking/></span>
   {identity}
   <span className="animal-thinking-label" role="status" aria-live="polite" aria-atomic="true">{definition.label}</span>
  </div>
 </div>;
}
