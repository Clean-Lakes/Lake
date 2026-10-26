import {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import type {WorkSession} from '../../shared/contracts';
import {AgentIcon} from './AgentIcon';
import {Glyph} from './Icons';
import {pilotRoleStatus,pilotIslandFocus, type PilotIslandModel} from './pilotIslandModel';

export function PilotStatusIsland({model, onInspect,visible=true,status}: {model: PilotIslandModel; status?:WorkSession['status']; visible?:boolean; onInspect: (targetId: string) => void}) {
  const [open, setOpen] = useState(false), [present,setPresent]=useState(false);
  const motion=useRef<Animation|null>(null);
  const [position, setPosition] = useState<{left: number; top: number; above:boolean; width:number} | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null);
  const panelId = useId(), headingId = useId();
  const close = (restore = false) => {setOpen(false); if (restore) trigger.current?.focus({preventScroll: true});};
  useEffect(() => {motion.current?.cancel();motion.current=null;setOpen(false);setPresent(false);setPosition(null);}, [model.taskId, model.planId,visible]);
  useEffect(()=>()=>{motion.current?.cancel();},[]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !panel.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const bubble = trigger.current.closest('.workspace-header')?.getBoundingClientRect() ?? anchor;
      // Match the specialist segment on desktop. If that segment is too narrow
      // for role details, use the title bubble's own edges instead of overhanging.
      const segment=bubble.right-anchor.left,compact=segment<280;
      const width=Math.min(window.innerWidth-24,compact?bubble.width:segment);
      panel.current.style.width=`${width}px`;
      const box=panel.current.getBoundingClientRect();
      const left = Math.max(12, Math.min(compact?bubble.left:anchor.left, window.innerWidth-width-12));
      const below = bubble.bottom + 8;
      const top = Math.max(12, Math.min(below + box.height <= window.innerHeight - 12 ? below : bubble.top - box.height - 8, window.innerHeight - box.height - 12));
      setPosition(p => p?.left === left && p.top === top && p.width===width ? p : {left, top,above:top<below,width});
    };
    place();
    const observer = new ResizeObserver(place);
    for (const element of [trigger.current, panel.current, trigger.current?.closest('.workspace'),trigger.current?.closest('.workspace-header')]) if (element) observer.observe(element);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => {observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);};
  }, [open]);
  useLayoutEffect(()=>{
    const node=panel.current;
    if(!node||!present||!position)return;
    if(!visible||document.hidden||window.matchMedia('(prefers-reduced-motion: reduce)').matches||!node.animate){
      motion.current?.cancel();motion.current=null;if(!open)setPresent(false);return;
    }
    const closed={opacity:0,transform:`translateY(${position.above?5:-5}px)`,clipPath:position.above?'inset(100% 0 0 0)':'inset(0 0 100% 0)'};
    const expanded={opacity:1,transform:'translateY(0)',clipPath:'inset(0 0 0 0)'};
    const style=getComputedStyle(node);
    const from=motion.current?{opacity:style.opacity,transform:style.transform,clipPath:style.clipPath}:open?closed:expanded;
    motion.current?.cancel();
    const animation=node.animate([from,open?expanded:closed],{duration:open?220:160,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'});
    motion.current=animation;
    animation.onfinish=()=>{if(motion.current!==animation)return;motion.current=null;animation.cancel();if(!open)setPresent(false)};
  },[open,present,!!position,visible]);
  // The first positioning pass mounts the panel hidden. Focus only once that
  // pass made it visible; hidden elements cannot receive keyboard focus.
  useLayoutEffect(() => {
    if(!open||!position)return;
    const frame=requestAnimationFrame(()=>{const node=panel.current;if(node&&!node.contains(document.activeElement))node.focus({preventScroll:true});});
    return()=>cancelAnimationFrame(frame);
  }, [open, !!position]);
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node && (trigger.current?.contains(target) || panel.current?.contains(target));
    const outside = (event: PointerEvent) => {if (!inside(event.target)) setOpen(false);};
    const focus = (event: FocusEvent) => {if (!inside(event.target)) setOpen(false);};
    const key = (event: KeyboardEvent) => {if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); close(true);}};
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', focus); document.addEventListener('keydown', key);
    return () => {document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', focus); document.removeEventListener('keydown', key);};
  }, [open]);
  const {primary,action,secondary}=pilotIslandFocus(model);
  const ended=model.tone==='neutral'&&['completed','cancelled'].includes(model.status);
  const progress=model.total?Math.max(0,Math.min(100,model.completed/model.total*100)):0;
  const inspect = (target: string) => {close(); onInspect(target);};
  return <div className="pilot-island" data-tone={model.tone} data-pilot-task={model.taskId}>
    <button ref={trigger} type="button" className="pilot-island-trigger" aria-label={`Lake Pilot：${model.detail}。${primary?.name??''}：${action}。${secondary}。查看专员进度`} aria-haspopup="dialog" disabled={!visible} aria-expanded={visible&&open} aria-controls={open ? panelId : undefined} title={model.detail} onClick={() => {if(open)close();else{setPresent(true);setOpen(true);}}}>
      {primary&&<span className={`pilot-action-avatar role-state-${primary.status}`} aria-hidden="true"><AgentIcon role={primary.role} size={22}/></span>}
      <span className="pilot-island-action" aria-hidden="true"><span className="pilot-island-action-line">{primary&&<strong>{primary.name}</strong>}<span className="pilot-island-action-label" title={action}>{model.tone!=='active'&&<i className="pilot-action-state-dot"/>}{action}</span></span><small title={secondary}>{secondary}</small></span>
      <span className="pilot-island-progress" data-session-status={status} aria-hidden="true">{ended?<span className="pilot-island-ended" title={model.status==='completed'?'任务已结束':'任务已取消'}><Glyph name={model.status==='completed'?'check':'close'} size={16}/></span>:<svg className="pilot-island-ring" viewBox="0 0 28 28" fill="none"><circle className="pilot-ring-track" cx="14" cy="14" r="10"/><circle className="pilot-ring-value" opacity={model.completed>0?1:0} cx="14" cy="14" r="10" pathLength="100" strokeDasharray={`${progress} 100`} transform="rotate(-90 14 14)"/></svg>}<Glyph name="chevron" size={12}/></span>
    </button>
    <span className="visually-hidden" role="status" aria-live="polite">{model.detail}</span>
    {visible&&present && createPortal(<section ref={panel} id={panelId} className="pilot-island-panel" role="dialog" aria-hidden={!open} inert={!open} aria-labelledby={headingId} tabIndex={-1} data-state={open?'open':'closing'} style={{width:position?.width,left: position?.left ?? 12, top: position?.top ?? 12, visibility: position ? undefined : 'hidden'}}>
      <header><strong id={headingId}>Lake Pilot</strong></header>
      <p className={`pilot-island-detail tone-${model.tone}`}>{model.detail}</p>
      <div className="pilot-island-role-list">{model.roles.map(role => <div className="pilot-island-role-row" key={role.role}><button type="button" disabled={!role.messageId} aria-label={`查看${role.name}：${role.description}`} onClick={() => {if (role.messageId) inspect(`sre-message-${role.messageId}`);}}>
        <AgentIcon role={role.role} size={20}/><span className="pilot-island-role-copy"><strong>{role.name}</strong><small title={role.description}>{role.description}</small></span><span className="pilot-island-role-count" title="本角色已完成的真实步骤">{role.total ? `${role.completed} / ${role.total}` : '—'}</span><span className={`pilot-island-role-state role-state-${role.status}`}>{pilotRoleStatus(role)}</span>
      </button></div>)}</div>
      {model.planId && <button type="button" className="pilot-island-plan-link" onClick={() => inspect(`sre-plan-${model.taskId}`)}>查看完整计划<Glyph name="arrow" size={13}/></button>}
    </section>, document.body)}
  </div>;
}
