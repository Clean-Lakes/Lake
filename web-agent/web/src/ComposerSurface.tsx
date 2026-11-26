import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from "react";
import {animate,motionValue} from "motion";
import {AnimatePresence,motion,useReducedMotion} from "motion/react";
import {ProviderIcon} from "./ProviderIcon";
import {Glyph} from './Icons';

// Use the Prompt Box spring and hover timeline, applied to Lake's full-width dock.
const shellSpring={type:"spring",stiffness:400,damping:25,mass:1.5} as const;
const easeOut=[0.215,0.61,0.355,1] as const;
const easeOutQuad=[0.25,0.46,0.45,0.94] as const;
const previewSettleMs=320;

export function ComposerSurface({sessionId,dragging,pinnedOpen,modelBrand,children}:{
  sessionId:string;dragging:boolean;pinnedOpen:boolean;modelBrand?:string;children:ReactNode;
}) {
  const surface=useRef<HTMLDivElement>(null);
  const face=useRef<HTMLDivElement>(null);
  const contents=useRef<HTMLDivElement>(null);
  const syncLayout=useRef<()=>void>(undefined);
  const [editingSession,setEditingSession]=useState<string>();
  const editing=editingSession===sessionId;
  const compact=!editing&&!pinnedOpen;
  const [previewHovered,setPreviewHovered]=useState(false);
  const [previewReady,setPreviewReady]=useState(compact);
  const reduceMotion=useReducedMotion();

  useEffect(()=>{
    setPreviewHovered(false);
    if(!compact){
      setPreviewReady(false);
      return;
    }
    const timer=window.setTimeout(()=>setPreviewReady(true),previewSettleMs);
    return()=>window.clearTimeout(timer);
  },[compact]);

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
    const box=surface.current,backplate=face.current,content=contents.current,rail=box?.parentElement;
    const editor=content?.querySelector<HTMLElement>(".composer-body");
    const toolbar=content?.querySelector<HTMLElement>(".composer-foot");
    if(!box||!backplate||!content||!rail||!editor||!toolbar)return;

    const gap=parseFloat(getComputedStyle(box).getPropertyValue("--composer-toolbar-gap"))||0;
    const minimumFrame=parseFloat(getComputedStyle(backplate).minHeight)||0;
    const reduced=window.matchMedia("(prefers-reduced-motion: reduce)");
    const layout=()=>{
      const compact=box.hasAttribute("data-composer-compact");
      const height=box.getBoundingClientRect().height;
      toolbar.inert=compact;
      // The hidden toolbar is still measured so wrapping on touch screens reserves its real height.
      if(compact&&height)rail.style.setProperty("--composer-reserved-height",`${height+toolbar.offsetHeight+gap}px`);
      else rail.style.removeProperty("--composer-reserved-height");
      return {compact,height,width:rail.offsetWidth};
    };

    let last=layout();
    let moveEditor=false;
    const height=motionValue(last.height);
    const paint=(value:number)=>{
      const visibleHeight=Math.max(minimumFrame,value);
      backplate.style.height=`${visibleHeight}px`;
      if(moveEditor)editor.style.translate=`0px ${last.height-visibleHeight}px`;
    };
    const unsubscribe=height.on("change",paint);
    const settle=()=>{
      moveEditor=false;
      editor.style.removeProperty("translate");
    };
    const animateLayout=()=>{
      const previous=last;
      last=layout();
      if(previous.width!==last.width||!last.height||!previous.height||document.hidden){
        height.jump(last.height);
        settle();
        return;
      }
      if(last.height===previous.height)return;
      moveEditor=moveEditor||last.compact!==previous.compact;
      // Only the absolute frame changes height each tick. The editor follows its top edge.
      paint(height.get());
      const transition=reduced.matches?{duration:0.2,ease:easeOutQuad}:shellSpring;
      animate(height,last.height,{...transition,onComplete:settle});
    };
    paint(height.get());
    syncLayout.current=animateLayout;
    const resize=new ResizeObserver(animateLayout);
    resize.observe(content);
    resize.observe(toolbar);
    return()=>{
      resize.disconnect();
      unsubscribe();
      height.destroy();
      settle();
      backplate.style.removeProperty("height");
      rail.style.removeProperty("--composer-reserved-height");
      syncLayout.current=undefined;
    };
  },[sessionId]);

  useLayoutEffect(()=>syncLayout.current?.(),[compact]);

  const focusEditor=()=>{
    const editor=contents.current?.querySelector<HTMLElement>('.composer-rich-input[contenteditable="true"]');
    if(!editor)return;
    editor.focus({preventScroll:true});
    setEditingSession(sessionId);
  };

  return <div ref={surface} className={`composer-input composer-resizing-surface${dragging?" attachment-drop-active":""}`}
    data-composer-compact={compact||undefined} onMouseEnter={()=>{
      if(compact&&window.matchMedia("(hover:hover) and (pointer:fine)").matches)setPreviewHovered(true);
    }} onMouseLeave={()=>setPreviewHovered(false)} onFocusCapture={event=>{
      if(event.target.matches(".composer-rich-input"))setEditingSession(sessionId);
    }} onClick={event=>{
      const target=event.target;
      if(!compact||!(target instanceof Element)
        ||(target!==event.currentTarget&&target!==contents.current&&!target.closest(".composer-body")))return;
      focusEditor();
    }}>
    <div className="composer-backplate" ref={face} aria-hidden="true"/>
    <div className="composer-file-drop-overlay" aria-hidden="true">
      <Glyph name="upload" size={18}/>松开添加附件
    </div>
    <span className="visually-hidden" role="status">{dragging?'松开添加附件':''}</span>
    <div className="composer-resizing-content" ref={contents}>
      {children}
      {compact&&modelBrand&&<span className="composer-model-preview" aria-hidden="true">
        <AnimatePresence>
          {previewReady&&previewHovered&&<motion.span
            initial={reduceMotion?{opacity:0}:{opacity:0,x:28,rotate:-360}}
            animate={reduceMotion?{opacity:1}:{opacity:1,x:0,rotate:0}}
            exit={reduceMotion?{opacity:0}:{opacity:0,x:22,rotate:120}}
            transition={reduceMotion?{duration:0.15,ease:easeOutQuad}:{duration:0.38,ease:easeOut}}>
            <ProviderIcon brand={modelBrand} size={16}/>
          </motion.span>}
        </AnimatePresence>
      </span>}
    </div>
  </div>;
}
