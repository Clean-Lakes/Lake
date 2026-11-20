import {useId, useLayoutEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {Glyph} from './Icons';
import {useTerminalPopover} from './useTerminalPopover';
import type {PilotParticipant} from './superPilotActivity';

export function PilotActiveSpecialists({participants}: {participants: readonly PilotParticipant[]}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const count = participants.length;
  const hasParticipants = count > 0;
  const {trigger, menu} = useTerminalPopover(open && hasParticipants, () => setOpen(false));
  const preview = participants.slice(0, 4);
  const remaining = count - preview.length;

  useLayoutEffect(() => {
    if (!open) return;
    if (!hasParticipants) {setOpen(false); return;}
    const anchor = trigger.current, panel = menu.current;
    if (!anchor || !panel) return;
    const island = anchor.closest('.workspace-header') ?? anchor;
    const place = () => {
      const bounds = island.getBoundingClientRect();
      panel.style.left = `${Math.max(12, Math.min(bounds.left, innerWidth - panel.offsetWidth - 12))}px`;
      panel.style.top = `${bounds.bottom + 8}px`;
      panel.style.maxHeight = `${Math.max(0, Math.min(360, innerHeight - bounds.bottom - 20))}px`;
    };
    place();
    panel.focus({preventScroll: true});
    const observer = new ResizeObserver(place);
    observer.observe(island);
    window.addEventListener('resize', place);
    return () => {observer.disconnect(); window.removeEventListener('resize', place);};
  }, [open, hasParticipants, trigger, menu]);

  if (!count) return null;
  const names = participants.map(person => person.name).join('、');
  return <>
    <button ref={trigger} type="button" className="pilot-active-specialists-trigger" title={names}
      data-preferred-width={6 + preview.length * 22 + (remaining > 0 ? 26 : 0)}
      aria-label={`查看参与协作的 ${count} 位专员：${names}`} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
      <span className="pilot-active-specialists-strip" aria-hidden="true">
        {preview.map(person => <span className="pilot-active-specialist-avatar" key={person.key}>
          <SuperRoleAvatar roleId={person.roleId} name={person.name} motion={person.moving ? 'working' : 'still'} size={20}/>
        </span>)}
        {remaining > 0 && <span className="pilot-active-specialists-count">+{remaining}</span>}
      </span>
      <span className="pilot-active-specialists-compact" aria-hidden="true"><Glyph name="users" size={13}/>{count}</span>
    </button>
    {open && createPortal(<div ref={menu} id={id} className="pilot-active-specialists-panel" role="dialog"
      aria-label="参与协作的专员" tabIndex={-1}>
      <ul>{participants.map(person => <li key={person.key}>
        <SuperRoleAvatar roleId={person.roleId} name={person.name} motion={person.moving ? 'working' : 'still'} size={24}/>
        <div><strong>{person.name}</strong><small>{person.detail}</small></div>
      </li>)}</ul>
    </div>, document.body)}
  </>;
}
