import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';

// Keep the original reply node mounted through completion. CSS folds its actual
// height while the final reply stays mounted and keeps its streaming identity.
export function SettledReply({collapsed,handoff=false,children}: {collapsed: boolean;handoff?:boolean; children: ReactNode}) {
  const ref=useRef<HTMLDivElement>(null);
  const [phase,setPhase]=useState({handoff,released:!handoff}),[entering,setEntering]=useState(false);
  if(phase.handoff!==handoff)setPhase({handoff,released:!handoff});
  const waiting=handoff&&!phase.released&&!collapsed;
  useLayoutEffect(()=>{
    if(!waiting)return;
    const motion=matchMedia('(prefers-reduced-motion: reduce)');
    const turn=ref.current?.closest('.ai-turn');
    const outgoing=[...turn?.querySelectorAll<HTMLElement>('.turn-execution-details,.settled-reply.is-archived')??[]].filter(node=>node!==ref.current&&node.getBoundingClientRect().height>1);
    let disposed=false,leadReady=!turn?.querySelector('.reply-duration');
    const reveal=()=>{if(!disposed){setEntering(!motion.matches&&!document.hidden);setPhase({handoff,released:true});}};
    const check=()=>{if(motion.matches||document.hidden||leadReady&&outgoing.every(node=>node.getBoundingClientRect().height<=1))reveal();};
    // Let the elapsed row establish itself before the reply enters beneath it.
    const leadTimer=setTimeout(()=>{leadReady=true;check();},120);
    // Grid collapse is 360ms. Transition events normally release the reply;
    // the bounded fallback also handles cancelled/missing WebKit events.
    const timer=setTimeout(reveal,400);
    turn?.addEventListener('transitionend',check);
    document.addEventListener('visibilitychange',check);motion.addEventListener('change',check);check();
    return()=>{disposed=true;clearTimeout(timer);clearTimeout(leadTimer);turn?.removeEventListener('transitionend',check);document.removeEventListener('visibilitychange',check);motion.removeEventListener('change',check);};
  },[waiting,handoff]);
  useLayoutEffect(()=>{
    if(!entering)return;
    if(collapsed){setEntering(false);return;}
    const motion=matchMedia('(prefers-reduced-motion: reduce)');
    const stop=()=>{if(motion.matches||document.hidden)setEntering(false);};
    const timer=setTimeout(()=>setEntering(false),260);
    motion.addEventListener('change',stop);document.addEventListener('visibilitychange',stop);
    return()=>{clearTimeout(timer);motion.removeEventListener('change',stop);document.removeEventListener('visibilitychange',stop);};
  },[entering,collapsed]);
  return <div ref={ref} className={`settled-reply${collapsed ? ' is-archived' : ''}${waiting?' is-awaiting-reply':''}${entering&&!collapsed?' is-presenting-reply':''}`} aria-hidden={collapsed||waiting||undefined} inert={collapsed||waiting} onAnimationEnd={event=>{if(event.target===event.currentTarget&&event.animationName==='reply-handoff-in')setEntering(false);}}>
    <div className="settled-reply-content">{waiting?null:children}</div>
  </div>;
}
