import {useLayoutEffect,useRef,type ReactNode} from 'react';

export type PilotReplyContentState={binding:string;kind:'prose'|'plan'|'status';id:string;text:string};
export const PILOT_REPLY_TRANSITION_MS=160;

/** Only a replacement needs a transition; received prefixes already stream smoothly. */
export function changesPilotReplyContent(previous:PilotReplyContentState|undefined,next:PilotReplyContentState){
 if(!previous||previous.binding!==next.binding)return false;
 if(previous.kind===next.kind&&previous.text===next.text)return false;
 return !(previous.kind==='prose'&&next.kind==='prose'&&previous.id===next.id&&next.text.startsWith(previous.text));
}

type ContentSurface=Pick<HTMLElement,'animate'>;
type VisualState={opacity:string;transform:string;height?:string};

/** Owns only the body transition, never the identity's or text glyphs' clocks. */
export class PilotReplyContentTransition {
 private previous:PilotReplyContentState|undefined;
 private animation:Animation|undefined;
 private height:number|undefined;
 constructor(private surface:ContentSurface,private visual:()=>VisualState){}
 update(next:PilotReplyContentState,enabled:boolean,height?:number){
  const changed=changesPilotReplyContent(this.previous,next),sameBinding=this.previous?.binding===next.binding;
  const before=this.height;this.height=height;
  this.previous=next;
  if(!enabled||!sameBinding){this.stop();return;}
  // A prefix or loaded attachment can grow during a replacement. Release the
  // old height rather than clipping new lines until its stale endpoint ends.
  if(!changed){if(before!==undefined&&height!==undefined&&Math.abs(before-height)>.5)this.stop();return;}
  if(typeof this.surface.animate!=='function')return;
  // Commit the new content immediately. Fast replacements continue from the
  // current painted position instead of clearing or cloning readable content.
  const from:Keyframe=this.animation?this.visual():{opacity:'0.78',transform:'translateY(2px)'};
  const to:Keyframe={opacity:'1',transform:'translateY(0)'};
  if(before!==undefined&&height!==undefined&&Math.abs(before-height)>.5){
   from.height=from.height??`${before}px`;to.height=`${height}px`;
   from.overflow=to.overflow='clip';
  }
  this.stop();
  const animation=this.surface.animate([from,to],{
   duration:PILOT_REPLY_TRANSITION_MS,easing:'cubic-bezier(.22,1,.36,1)',fill:'none',
  });
  this.animation=animation;
  animation.onfinish=()=>{if(this.animation===animation)this.stop();};
 }
 stop(){
  if(this.animation){this.animation.onfinish=null;this.animation.cancel();this.animation=undefined;}
 }
}

export function PilotReplyContent({state,active,children}:{state:PilotReplyContentState;active:boolean;children:ReactNode}){
 const surface=useRef<HTMLDivElement>(null),latest=useRef({state,active});latest.current={state,active};
 const body=useRef<HTMLDivElement>(null);
 const sync=useRef<()=>void>(()=>{});
 useLayoutEffect(()=>{
  const element=surface.current;if(!element)return;
  const media=window.matchMedia('(prefers-reduced-motion: reduce)');
  const transition=new PilotReplyContentTransition(element,()=>{
   const style=getComputedStyle(element);return {opacity:style.opacity,transform:style.transform,height:style.height};
  });
  const update=()=>transition.update(latest.current.state,latest.current.active&&!document.hidden&&!media.matches,body.current?.getBoundingClientRect().height);
  const stop=()=>transition.stop();
  sync.current=update;
  // Track smooth prefix growth without remounting or measuring the whole page.
  const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(update);
  if(body.current)observer?.observe(body.current);
  document.addEventListener('visibilitychange',update);media.addEventListener('change',update);
  element.addEventListener('focusin',stop);
  return()=>{
   sync.current=()=>{};transition.stop();
   document.removeEventListener('visibilitychange',update);media.removeEventListener('change',update);
   element.removeEventListener('focusin',stop);observer?.disconnect();
  };
 },[]);
 useLayoutEffect(()=>sync.current());
 return <div ref={surface} className="pilot-specialist-reply-content"><div ref={body} className="pilot-specialist-reply-body">{children}</div></div>;
}
