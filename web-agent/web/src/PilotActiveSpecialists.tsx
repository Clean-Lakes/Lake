import {useId, useLayoutEffect, useRef, useState, type CSSProperties} from 'react';
import {createPortal} from 'react-dom';
import {SuperRoleAvatar} from './SuperRoleAvatar';
import {useTerminalPopover} from './useTerminalPopover';
import type {PilotParticipant} from './superPilotActivity';

export function PilotActiveSpecialists({participants, visible = true, fixedRoster = false}: {
  participants: readonly PilotParticipant[]; visible?: boolean; fixedRoster?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const expanded = visible && participants.length > 0;
  const retained = useRef(participants);
  useLayoutEffect(() => { if (expanded) retained.current = participants; }, [expanded, participants]);
  const shown = expanded ? participants : retained.current;
  const count = shown.length;
  const {trigger, menu} = useTerminalPopover(open && expanded, () => setOpen(false));
  const preview = shown.slice(0, 4);
  const remaining = count - preview.length;
  const compactCount = Math.min(2, count);
  const compactRemaining = count - compactCount;
  const preferredWidth = count ? 10 + preview.length * 18 + (remaining > 0 ? 26 : 0) : 0;
  const compactWidth = count ? 10 + compactCount * 18 + (compactRemaining > 0 ? 26 : 0) : 0;

  useLayoutEffect(() => {
    const anchor = trigger.current;
    if (!expanded) {
      if (open || document.activeElement === anchor) {
        anchor?.closest('.workspace-header')?.querySelector<HTMLButtonElement>('.header-morph-slot.is-visible .header-inspector-toggle')?.focus({preventScroll:true});
      }
      if (open) setOpen(false);
      return;
    }
    if (!open) return;
    const panel = menu.current;
    if (!anchor || !panel) return;
    const island = anchor.closest('.workspace-header') ?? anchor;
    const place = () => {
      const bounds = island.getBoundingClientRect();
      panel.style.left = `${Math.max(12, Math.min(anchor.getBoundingClientRect().left, innerWidth - panel.offsetWidth - 12))}px`;
      panel.style.top = `${bounds.bottom + 8}px`;
      panel.style.maxHeight = `${Math.max(0, Math.min(360, innerHeight - bounds.bottom - 20))}px`;
    };
    place();
    panel.focus({preventScroll: true});
    const observer = new ResizeObserver(place);
    observer.observe(island);
    observer.observe(anchor);
    window.addEventListener('resize', place);
    return () => {observer.disconnect(); window.removeEventListener('resize', place);};
  }, [open, expanded, trigger, menu]);

  const names = shown.map(person => person.name).join('、');
  return <>
    <div className="pilot-active-specialists-slot" data-pilot-roster-open={expanded}
      data-preferred-width={preferredWidth} data-compact-width={compactWidth}
      style={{'--pilot-roster-wide-width':`${preferredWidth}px`,'--pilot-roster-compact-width':`${compactWidth}px`} as CSSProperties}
      inert={!expanded} aria-hidden={!expanded}>
      {count > 0 && <button ref={trigger} type="button" className="pilot-active-specialists-trigger" title={names} disabled={!expanded}
        aria-label={fixedRoster?`查看群组成员：${names}`:`查看参与协作的 ${count} 位专员：${names}`} aria-haspopup="dialog" aria-expanded={open && expanded}
        aria-controls={open && expanded ? id : undefined} onClick={() => setOpen(!open)}>
        <span className="pilot-active-specialists-strip" aria-hidden="true">
          {preview.map(person => <span className="pilot-active-specialist-avatar" key={person.key}>
            <SuperRoleAvatar roleId={person.roleId} name={person.name} avatarId={person.avatarId} motion={expanded && person.moving ? 'working' : 'still'} size={20}/>
          </span>)}
          {remaining > 0 && <span className="pilot-active-specialists-count">+{remaining}</span>}
          {compactRemaining > 0 && <span className="pilot-active-specialists-count" data-compact>+{compactRemaining}</span>}
        </span>
      </button>}
    </div>
    {open && expanded && createPortal(<div ref={menu} id={id} className="pilot-active-specialists-panel" role="dialog"
      aria-label={fixedRoster?'群组成员':'参与协作的专员'} tabIndex={-1}>
      <ul>{participants.map(person => <li key={person.key}>
        <SuperRoleAvatar roleId={person.roleId} name={person.name} avatarId={person.avatarId} motion={person.moving ? 'working' : 'still'} size={24}/>
        <div><strong>{person.name}</strong>{person.detail&&<small>{person.detail}</small>}</div>
      </li>)}</ul>
    </div>, document.body)}
  </>;
}
