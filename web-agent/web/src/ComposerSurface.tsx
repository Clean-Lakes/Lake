import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from "react";
import {canAnimateControls,controlMotionEase} from "./controlMotion";

export function ComposerSurface({sessionId,dragging,pinnedOpen,children}:{
  sessionId:string;dragging:boolean;pinnedOpen:boolean;children:ReactNode;
}) {
  const surface=useRef<HTMLDivElement>(null);
  const face=useRef<HTMLDivElement>(null);
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
    // Safari can blur the editor without focusing the button that was clicked.
    document.addEventListener("pointerdown",leave,true);
    document.addEventListener("focusin",leave);
    return()=>{
      document.removeEventListener("pointerdown",leave,true);
      document.removeEventListener("focusin",leave);
    };
  },[editing,editingSession]);

  useLayoutEffect(()=>{
    const box=surface.current,backplate=face.current,content=contents.current;
    const editor=content?.querySelector<HTMLElement>(".composer-body");
    const tools=content?.querySelector<HTMLElement>(".composer-foot");
    if(!box||!backplate||!content||!editor||!tools)return;
    const geometry=()=>{
      const frame=box.getBoundingClientRect();
      const shift=parseFloat(getComputedStyle(editor).translate?.split(" ")[1]??"0")||0;
      return {width:box.offsetWidth,height:frame.height,editorTop:editor.getBoundingClientRect().top-frame.bottom-shift,
        shift,compact:box.hasAttribute("data-composer-compact")};
    };
    let last=geometry();
    let plateMotion:Animation|undefined,editorMotion:Animation|undefined,toolMotion:Animation|undefined;
    const clearMotion=()=>{plateMotion?.cancel();editorMotion?.cancel();toolMotion?.cancel();};
    const resize=new ResizeObserver(()=>{
      const next=geometry(),previous=last;
      last=next;
      const layoutChanged=previous.compact!==next.compact;
      if(next.width!==previous.width||!canAnimateControls()||!backplate.animate){
        clearMotion();
        return;
      }
      if(!layoutChanged&&Math.abs(next.height-previous.height)<1)return;
      const scale=parseFloat(getComputedStyle(backplate).scale?.split(" ")[1]??"1")||1;
      plateMotion?.cancel();
      editorMotion?.cancel();
      const visualHeight=previous.height*scale;
      const from=layoutChanged?visualHeight:Math.max(next.height-32,Math.min(next.height+32,visualHeight));
      const timing={duration:layoutChanged?200:145,easing:controlMotionEase};
      // The conversation has its final layout already. Only the painted frame and editor move.
      plateMotion=backplate.animate([{scale:`1 ${from/next.height}`},{scale:"1 1"}],timing);
      if(layoutChanged){
        const offset=previous.editorTop+next.shift-next.editorTop;
        editorMotion=editor.animate([{translate:`0px ${offset}px`},{translate:"0px 0px"}],timing);
        toolMotion?.cancel();
        if(!next.compact&&!tools.contains(document.activeElement)){
          toolMotion=tools.animate([
            {opacity:0,pointerEvents:"none",offset:0},
            {opacity:0,pointerEvents:"none",offset:0.72},
            {opacity:1,pointerEvents:"auto",offset:1},
          ],{duration:timing.duration,easing:"linear"});
        }
      }
    });
    const revealTools=()=>{toolMotion?.cancel();};
    resize.observe(content);
    tools.addEventListener("focusin",revealTools);
    return()=>{resize.disconnect();tools.removeEventListener("focusin",revealTools);clearMotion();};
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
    <div className="composer-backplate" ref={face} aria-hidden="true"/>
    <div className="composer-resizing-content" ref={contents}>{children}</div>
  </div>;
}
