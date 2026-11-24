import {useLayoutEffect,useRef,type ReactNode} from "react";
import {canAnimateControls,controlMotionEase} from "./controlMotion";

export function ComposerSurface({sessionId,dragging,children}:{sessionId:string;dragging:boolean;children:ReactNode}) {
  const surface=useRef<HTMLDivElement>(null);
  const contents=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const box=surface.current,content=contents.current;
    if(!box||!content)return;
    let height=box.getBoundingClientRect().height,width=content.offsetWidth;
    let animation:Animation|undefined;
    const resize=new ResizeObserver(([entry])=>{
      if(!entry)return;
      const style=getComputedStyle(box);
      const chrome=[style.paddingTop,style.paddingBottom,style.borderTopWidth,style.borderBottomWidth]
        .reduce((total,value)=>total+parseFloat(value),0);
      const nextHeight=entry.contentRect.height+chrome;
      const nextWidth=content.offsetWidth;
      const previousHeight=height;
      const widthChanged=nextWidth!==width;
      height=nextHeight;
      width=nextWidth;
      if(widthChanged||!canAnimateControls()||!box.animate){
        animation?.cancel();
        animation=undefined;
        return;
      }
      if(Math.abs(nextHeight-previousHeight)<1)return;
      const currentHeight=animation?.playState==="running"?box.getBoundingClientRect().height:previousHeight;
      animation?.cancel();
      // Keep newly entered lines visible while the bottom-anchored surface catches up.
      const start=Math.min(nextHeight+32,Math.max(nextHeight-32,currentHeight));
      animation=box.animate([{height:`${start}px`},{height:`${nextHeight}px`}],
        {duration:155,easing:controlMotionEase});
    });
    resize.observe(content);
    return()=>{resize.disconnect();animation?.cancel();};
  },[sessionId]);
  return <div ref={surface} className={`composer-input composer-resizing-surface${dragging?" attachment-drop-active":""}`}>
    <div ref={contents} className="composer-resizing-content">{children}</div>
  </div>;
}
