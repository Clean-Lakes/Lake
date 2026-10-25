import {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {AgentIcon} from './AgentIcon';
import {Glyph} from './Icons';
import {pilotRoleStatus, type PilotIslandModel} from './pilotIslandModel';

export function PilotStatusIsland({model, onInspect}: {model: PilotIslandModel; onInspect: (targetId: string) => void}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{left: number; top: number} | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null);
  const panelId = useId(), headingId = useId();
  const close = (restore = false) => {setOpen(false); if (restore) trigger.current?.focus({preventScroll: true});};
  useEffect(() => {setOpen(false);}, [model.taskId, model.planId]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !panel.current) return;
      const anchor = trigger.current.getBoundingClientRect(), box = panel.current.getBoundingClientRect();
      const bubble = trigger.current.closest('.workspace-header')?.getBoundingClientRect() ?? anchor;
      const left = Math.max(12, Math.min(anchor.right - box.width, window.innerWidth - box.width - 12));
      const below = bubble.bottom + 8;
      const top = Math.max(12, Math.min(below + box.height <= window.innerHeight - 12 ? below : bubble.top - box.height - 8, window.innerHeight - box.height - 12));
      setPosition(p => p?.left === left && p.top === top ? p : {left, top});
    };
    place();
    const observer = new ResizeObserver(place);
    for (const element of [trigger.current, panel.current, trigger.current?.closest('.workspace')]) if (element) observer.observe(element);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => {observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);};
  }, [open]);
  // The first positioning pass mounts the panel hidden. Focus only once that
  // pass made it visible; hidden elements cannot receive keyboard focus.
  useLayoutEffect(() => {if (open && position) panel.current?.focus({preventScroll: true});}, [open, !!position]);
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node && (trigger.current?.contains(target) || panel.current?.contains(target));
    const outside = (event: PointerEvent) => {if (!inside(event.target)) setOpen(false);};
    const focus = (event: FocusEvent) => {if (!inside(event.target)) setOpen(false);};
    const key = (event: KeyboardEvent) => {if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); close(true);}};
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', focus); document.addEventListener('keydown', key);
    return () => {document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', focus); document.removeEventListener('keydown', key);};
  }, [open]);
  const roleNames = model.visibleRoles.map(r => r.name).join(' + ');
  const inspect = (target: string) => {close(); onInspect(target);};
  return <div className="pilot-island" data-tone={model.tone} data-pilot-task={model.taskId}>
    <button ref={trigger} type="button" className="pilot-island-trigger" aria-label={`Lake Pilot：${model.detail}。查看专员进度`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} title={model.detail} onClick={() => setOpen(value => !value)}>
      {!!model.visibleRoles.length && <span className="pilot-island-roles" aria-hidden="true">
        <span className="pilot-island-avatars">{model.visibleRoles.map(r => <span key={r.role} className={`pilot-island-avatar role-state-${r.status}`} title={`${r.name} · ${pilotRoleStatus(r)}`}><AgentIcon role={r.role} size={17}/><i/></span>)}</span>
        <span className="pilot-island-role-names">{model.visibleRoles.length > 2 ? `${model.visibleRoles.length} 位专员` : roleNames}</span>
      </span>}
      <span className="pilot-island-progress">
        <span className="pilot-island-summary"><span className="pilot-island-label"><i/><span>{model.label}</span></span><span className="pilot-island-count">{model.total ? <>{model.completed}<span> / {model.total}</span></> : '—'}</span><Glyph name="chevron" size={12}/></span>
        <span className="pilot-island-track" aria-hidden="true">{model.steps.map(s => <i key={s.step.id} className={`step-${s.status}`}/>)}</span>
      </span>
    </button>
    <span className="visually-hidden" role="status" aria-live="polite">{model.detail}</span>
    {open && createPortal(<section ref={panel} id={panelId} className="pilot-island-panel" role="dialog" aria-labelledby={headingId} tabIndex={-1} style={{left: position?.left ?? 12, top: position?.top ?? 12, visibility: position ? undefined : 'hidden'}}>
      <header><strong id={headingId}>Lake Pilot</strong><button type="button" className="icon-button" aria-label="关闭专员进度" onClick={() => close(true)}><Glyph name="close" size={15}/></button></header>
      <p className={`pilot-island-detail tone-${model.tone}`}>{model.detail}</p>
      <div className="pilot-island-role-list">{model.roles.map(role => <div className="pilot-island-role-row" key={role.role}><button type="button" disabled={!role.messageId} aria-label={`查看${role.name}：${role.description}`} onClick={() => {if (role.messageId) inspect(`sre-message-${role.messageId}`);}}>
        <AgentIcon role={role.role} size={20}/><span className="pilot-island-role-copy"><strong>{role.name}</strong><small title={role.description}>{role.description}</small></span><span className="pilot-island-role-count" title="本角色已完成的真实步骤">{role.total ? `${role.completed} / ${role.total}` : '—'}</span><span className={`pilot-island-role-state role-state-${role.status}`}>{pilotRoleStatus(role)}</span>
      </button></div>)}</div>
      {model.planId && <button type="button" className="pilot-island-plan-link" onClick={() => inspect(`sre-plan-${model.taskId}`)}>查看完整计划<Glyph name="arrow" size={13}/></button>}
    </section>, document.body)}
  </div>;
}
