import {useLayoutEffect,useRef,type RefObject} from 'react';

const lightAnimations=new Set(['workspace-header-sweep','lake-live-text-glow-rise','lake-live-text-rise']);
type AnimationRoot=Pick<Element,'getAnimations'>;

/** Existing CSS animations share the document clock; their own glyph delays remain intact. */
export function synchronizeLightAnimations(root:AnimationRoot|null,active:boolean){
 if(!root||!active||typeof root.getAnimations!=='function')return;
 for(const animation of root.getAnimations({subtree:true})){
  const name=(animation as CSSAnimation).animationName;
  if(!lightAnimations.has(name)||animation.playState!=='running'||animation.startTime===0)continue;
  animation.startTime=0;
 }
}

/** Align on commits and accessibility/visibility changes, never by polling or frames. */
export function useSynchronizedLight(ref:RefObject<HTMLElement|null>,active:boolean){
 const enabled=useRef(active);enabled.current=active;
 const synchronize=useRef<()=>void>(()=>{});
 useLayoutEffect(()=>{
  const media=window.matchMedia('(prefers-reduced-motion: reduce)');
  const align=()=>synchronizeLightAnimations(ref.current,enabled.current&&!document.hidden&&!media.matches);
  synchronize.current=align;
  document.addEventListener('visibilitychange',align);
  media.addEventListener('change',align);
  return()=>{
   document.removeEventListener('visibilitychange',align);
   media.removeEventListener('change',align);
   synchronize.current=()=>{};
  };
 },[ref]);
 // Streaming can add new glyphs without changing activity. Existing clocks are
 // already at zero, so an unrelated render neither restarts nor replaces them.
 useLayoutEffect(()=>{synchronize.current();});
}
