import {useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode} from 'react';

export type PilotReplyContentState={binding:string;kind:'prose'|'stages'|'plan'|'status';id:string;text:string;live?:boolean};
export const PILOT_REPLY_TRANSITION_MS=160;
export const PILOT_REPLY_EXIT_MS=80;
const visibleClip='inset(0% 0% 0% 0%)',hiddenClip='inset(0% 100% 0% 0%)';

function startsLiveProse(previous:PilotReplyContentState|undefined,next:PilotReplyContentState){
 return previous?.kind==='status'&&(next.kind==='prose'||next.kind==='stages')&&next.live===true;
}

/** Only a replacement needs a transition; received prefixes already stream smoothly. */
export function changesPilotReplyContent(previous:PilotReplyContentState|undefined,next:PilotReplyContentState){
 if(!previous||previous.binding!==next.binding||startsLiveProse(previous,next))return false;
 if(previous.kind==='stages'&&next.kind==='stages')return previous.id!==next.id;
 if(previous.kind===next.kind&&previous.text===next.text)return false;
 return !(previous.kind==='prose'&&next.kind==='prose'&&previous.id===next.id&&next.text.startsWith(previous.text));
}

type ContentSurface=Pick<HTMLElement,'animate'>;
type VisualState={clipPath:string;height?:string};

/** Owns only the body transition, never the identity's or text glyphs' clocks. */
export class PilotReplyContentTransition {
 private current:PilotReplyContentState|undefined;
 private target:PilotReplyContentState|undefined;
 private animation:Animation|undefined;
 private layout:Animation|undefined;
 private phase:'idle'|'exit'|'entry-ready'|'entry'='idle';
 private height:number|undefined;
 private beforeHeight:number|undefined;
 constructor(private surface:ContentSurface,private visual:()=>VisualState,private commit:(next:PilotReplyContentState)=>void=()=>{},private settled:(next:PilotReplyContentState)=>void=()=>{}){}
 update(next:PilotReplyContentState,enabled:boolean,height?:number){
  this.target=next;
  if(!enabled||this.current?.binding!==next.binding||startsLiveProse(this.current,next)||typeof this.surface.animate!=='function'){
   this.stop();this.current=next;this.height=height;this.commit(next);this.settled(next);return;
  }
  const changed=changesPilotReplyContent(this.current,next);
  if(this.phase==='exit'){
   // Finish retiring the painted paragraph once; bursts only replace its target.
   if(!changed){this.stop();this.current=next;this.height=height;this.commit(next);this.settled(next);}
   return;
  }
  if(this.phase==='entry-ready'){
   this.current=next;
   if(changed){this.commit(next);return;}
   const before=this.beforeHeight;this.clearAnimations();this.phase='entry';this.height=height;
   if(before!==undefined&&height!==undefined&&Math.abs(before-height)>.5)this.layout=this.surface.animate(
    [{height:`${before}px`,overflow:'clip'},{height:`${height}px`,overflow:'clip'}],
    {duration:PILOT_REPLY_TRANSITION_MS,easing:'cubic-bezier(.22,1,.36,1)',fill:'none'});
   const animation=this.surface.animate([{clipPath:hiddenClip},{clipPath:visibleClip}],{
    duration:PILOT_REPLY_TRANSITION_MS,easing:'cubic-bezier(.22,1,.36,1)',fill:'none',
   });
   this.animation=animation;animation.onfinish=()=>{if(this.animation===animation&&this.current){const finished=this.current;this.stop();this.settled(finished);}};
   this.commit(next);return;
  }
  if(!changed){
   // New lines and attachments release only the stale height; the reveal keeps
   // moving, without replaying either half of the text replacement.
   if(this.height!==undefined&&height!==undefined&&Math.abs(this.height-height)>.5)this.clearLayout();
   this.current=next;this.height=height;this.commit(next);if(this.phase==='idle')this.settled(next);return;
  }
  const painted=this.animation?this.visual():undefined;
  const before=painted?.height??(height===undefined?undefined:`${height}px`);
  this.clearAnimations();this.phase='exit';
  if(before)this.layout=this.surface.animate([{height:before,overflow:'clip'},{height:before,overflow:'clip'}],{duration:PILOT_REPLY_EXIT_MS,fill:'forwards'});
  const animation=this.surface.animate([{clipPath:painted?.clipPath&&painted.clipPath!=='none'?painted.clipPath:visibleClip},{clipPath:hiddenClip}],{
   duration:PILOT_REPLY_EXIT_MS,easing:'cubic-bezier(.4,0,1,1)',fill:'forwards',
  });
  this.animation=animation;
  animation.onfinish=()=>{
   if(this.animation!==animation||this.phase!=='exit')return;
   const measured=Number.parseFloat(this.visual().height??'');
   this.beforeHeight=Number.isFinite(measured)?measured:height;
   this.phase='entry-ready';this.current=this.target;this.commit(this.target!);
  };
 }
 private clearLayout(){if(this.layout){this.layout.cancel();this.layout=undefined;}}
 private clearAnimations(){
  if(this.animation){this.animation.onfinish=null;this.animation.cancel();this.animation=undefined;}
  this.clearLayout();
 }
 stop(){this.clearAnimations();this.phase='idle';}
}

export function PilotReplyContent({state,active,children,onPresented}:{state:PilotReplyContentState;active:boolean;children:ReactNode;onPresented?:(id:string)=>void}){
 const source=useMemo(()=>({state,children}),[state,children]);
 const [shown,setShown]=useState(source);
 const [presented,setPresented]=useState('');
 const allowed=active&&(typeof document==='undefined'||!document.hidden)&&(typeof window==='undefined'||!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
 const displayed=allowed&&changesPilotReplyContent(shown.state,state)?shown:source;
 const surface=useRef<HTMLDivElement>(null),latest=useRef({source,active,onPresented});
 const body=useRef<HTMLDivElement>(null);
 const sync=useRef<()=>void>(()=>{});
 useLayoutEffect(()=>{latest.current={source,active,onPresented};});
 useLayoutEffect(()=>{
  const element=surface.current;if(!element)return;
  const media=window.matchMedia('(prefers-reduced-motion: reduce)');
  const transition=new PilotReplyContentTransition(element,()=>{
   const style=getComputedStyle(element);return {clipPath:style.clipPath,height:style.height};
  },()=>setShown(latest.current.source),next=>{if(latest.current.onPresented)setPresented(next.id);});
  const update=()=>transition.update(latest.current.source.state,latest.current.active&&!document.hidden&&!media.matches,body.current?.getBoundingClientRect().height);
  const stop=()=>transition.update(latest.current.source.state,false,body.current?.getBoundingClientRect().height);
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
 useEffect(()=>{
  if(presented&&presented===state.id&&presented===displayed.state.id)onPresented?.(presented);
 },[presented,state.id,displayed.state.id,onPresented]);
 return <div ref={surface} className="pilot-specialist-reply-content"><div ref={body} className="pilot-specialist-reply-body">{displayed.children}</div></div>;
}
