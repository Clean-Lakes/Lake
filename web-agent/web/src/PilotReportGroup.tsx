import {useId, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {Glyph} from './Icons';
import {TaskSpecialistAvatars} from './TaskSpecialistAvatars';
import type {SpecialistTaskMember} from './specialistTaskListModel';

export function PilotReportGroup({members, count, fold, onInspect, children}: {
  members: readonly SpecialistTaskMember[];
  count: number;
  fold: boolean;
  onInspect?: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<boolean>();
  const reading = fold && expanded === undefined ? body.current : null;
  const selection = reading ? window.getSelection() : null;
  const keepReading = !!reading && (reading.contains(document.activeElement) ||
    reading.contains(selection?.anchorNode ?? null) || reading.contains(selection?.focusNode ?? null));
  const open = !fold || (expanded ?? keepReading);
  useLayoutEffect(() => {if (keepReading) setExpanded(true);}, [keepReading]);

  return <div className="pilot-report-group" data-folded={!open || undefined}>
    <button type="button" className="pilot-report-toggle" hidden={!fold} aria-expanded={open}
      aria-controls={id} aria-describedby={`${id}-authors`} onClick={() => {onInspect?.(); setExpanded(!open);}}>
      {fold && <TaskSpecialistAvatars members={members} descriptionId={`${id}-authors`}/>}
      <span>{count} 份专员报告</span>
      <Glyph name="next" size={12} className="pilot-report-chevron"/>
    </button>
    <div ref={body} id={id} className="pilot-report-body" aria-hidden={!open || undefined} inert={!open}>
      <div className="pilot-report-items">{children}</div>
    </div>
  </div>;
}
