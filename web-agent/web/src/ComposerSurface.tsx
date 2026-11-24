import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from "react";
import {canAnimateControls,controlMotionEase} from "./controlMotion";

export function ComposerSurface({sessionId,dragging,pinnedOpen,children}:{
  sessionId:string;dragging:boolean;pinnedOpen:boolean;children:ReactNode;
}) {
  const surface=useRef<HTMLDivElement>(null);
  const contents=useRef<HTMLDivElement>(null);
  const [editingSession,setEditingSession]=useState<string>();
  const editing=editingSession===sessionId;
  const compact=!editing&&!pinnedOpen&&!dragging;

  useEffect(()=>{
    if(!editing){
      if(editingSession!==undefined)setEditingSession(undefined);
      return;
    }
    const box=surface.current;
    const leave=(event:Event)=>{
      const target=event.target;
      if(target instanceof Element&&!box?.contains(target)
        &&!target.closest(".composer-model-popup,.composer-provider-popup,.permission-popover")){
        setEditingSession(undefined);
      }
    };
    // Pointer handling also covers Safari clicks on non-focusable elements.
    document.addEventListener("pointerdown",leave,true);
    document.addEventListener("focusin",leave);
    return()=>{
      document.removeEventListener("pointerdown",leave,true);
      document.removeEventListener("focusin",leave);
    };
  },[editing,editingSession]);

  useLayoutEffect(()=>{
    const box=surface.current,content=contents.current;
    const editor=content?.querySelector<HTMLElement>(".composer-body");
    if(!box||!content||!editor)return;
    const position=()=>{
      const frame=content.getBoundingClientRect(),field=editor.getBoundingClientRect();
      const [x=0,y=0]=getComputedStyle(editor).translate?.split(" ").map(value=>parseFloat(value)||0)??[];
      return {left:field.left-frame.left-x,top:field.top-frame.bottom-y,x,y};
    };
    let height=box.getBoundingClientRect().height,width=content.offsetWidth;
    let wasCompact=box.hasAttribute("data-composer-compact"),lastPosition=position();
    let animation:Animation|undefined,editorAnimation:Animation|undefined;
    const resize=new ResizeObserver(([entry])=>{
      if(!entry)return;
      const style=getComputedStyle(box);
      const chrome=[style.paddingTop,style.paddingBottom,style.borderTopWidth,style.borderBottomWidth]
        .reduce((total,value)=>total+parseFloat(value),0);
      const nextHeight=entry.contentRect.height+chrome;
      const nextWidth=content.offsetWidth,nextCompact=box.hasAttribute("data-composer-compact");
      const nextPosition=position(),previousPosition=lastPosition;
      const previousHeight=height;
      const widthChanged=nextWidth!==width,layoutChanged=nextCompact!==wasCompact;
      height=nextHeight;
      width=nextWidth;
      wasCompact=nextCompact;
      lastPosition=nextPosition;
      if(widthChanged||!canAnimateControls()||!box.animate){
        animation?.cancel();
        editorAnimation?.cancel();
        return;
      }
      if(!layoutChanged&&Math.abs(nextHeight-previousHeight)<1)return;
      const currentHeight=animation?.playState==="running"?box.getBoundingClientRect().height:previousHeight;
      animation?.cancel();
      const start=layoutChanged?currentHeight:Math.min(nextHeight+32,Math.max(nextHeight-32,currentHeight));
      const timing={duration:layoutChanged?190:155,easing:controlMotionEase};
      animation=box.animate([{height:`${start}px`},{height:`${nextHeight}px`}],timing);
      if(layoutChanged){
        // The actions stay on their bottom rail while the same editable field moves.
        editorAnimation?.cancel();
        const x=previousPosition.left+nextPosition.x-nextPosition.left;
        const y=previousPosition.top+nextPosition.y-nextPosition.top;
        editorAnimation=editor.animate([{translate:`${x}px ${y}px`},{translate:"0px 0px"}],timing);
      }
    });
    resize.observe(content);
    return()=>{resize.disconnect();animation?.cancel();editorAnimation?.cancel();};
  },[sessionId]);

  return <div ref={surface} className={`composer-input composer-resizing-surface${dragging?" attachment-drop-active":""}`}
    data-composer-compact={compact||undefined} onFocusCapture={event=>{
      if(event.target.matches(".composer-rich-input"))setEditingSession(sessionId);
    }} onClick={event=>{
      const target=event.target;
      if(!compact||!(target instanceof Element)
        ||(target!==event.currentTarget&&target!==contents.current&&!target.closest(".composer-body")))return;
      const editor=contents.current?.querySelector<HTMLElement>('.composer-rich-input[contenteditable="true"]');
      if(editor){
        editor.focus({preventScroll:true});
        setEditingSession(sessionId);
      }
    }}>
    <div ref={contents} className="composer-resizing-content">{children}</div>
  </div>;
}
