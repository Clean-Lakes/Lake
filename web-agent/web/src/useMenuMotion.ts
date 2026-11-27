import {useLayoutEffect,useRef,useState,type RefObject} from "react";
import {canAnimateControls,controlMotionEase} from "./controlMotion";

export const menuMotionDurations = {enter: 170, exit: 125} as const;
export const menuMotionFrames = {
  collapsed: {opacity: 0, transform: "scale(.92,.76)"},
  expanded: {opacity: 1, transform: "none"},
} as const;

/** Keep the surface painted during dismissal while the list immediately becomes inert. */
export function useMenuMotion(ref:RefObject<HTMLElement|null>,visible:boolean,enabled=true) {
  const [retained,setRetained]=useState(false);
  const motion=useRef<Animation|null>(null);
  useLayoutEffect(()=>()=>{motion.current?.cancel();motion.current=null;},[]);
  useLayoutEffect(()=>{
    const element=ref.current;
    const previous=motion.current;
    let interrupted:Keyframe|undefined;
    if(element&&previous?.playState==="running"){
      const style=getComputedStyle(element);
      interrupted={opacity:style.opacity,transform:style.transform};
    }
    previous?.cancel();
    motion.current=null;
    if(!enabled||!element||!element.animate||!canAnimateControls()){
      setRetained(false);
      return;
    }
    const {collapsed,expanded}=menuMotionFrames;
    const frames=visible?[interrupted??collapsed,expanded]:[interrupted??expanded,collapsed];
    if(visible)setRetained(true);
    const animation=element.animate(frames,{duration:visible?menuMotionDurations.enter:menuMotionDurations.exit,easing:controlMotionEase,fill:"both"});
    motion.current=animation;
    void animation.finished.then(()=>{
      if(motion.current!==animation)return;
      motion.current=null;
      if(visible)animation.cancel();
      else setRetained(false);
    },()=>{});
  },[ref,visible,enabled]);
  return enabled&&retained;
}
