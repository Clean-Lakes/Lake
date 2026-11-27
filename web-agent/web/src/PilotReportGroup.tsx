import {useId, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {Glyph} from './Icons';
import {TaskSpecialistAvatars} from './TaskSpecialistAvatars';
import {PilotReportFold, readingPilotReport} from './PilotReportFold';
import type {SpecialistTaskMember} from './specialistTaskListModel';

export function PilotReportGroup({members, count, fold, connected, children}: {
  members: readonly SpecialistTaskMember[];
  count: number;
  fold: boolean;
  connected: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<boolean>();
  const keepReading = fold && expanded === undefined && readingPilotReport(body.current);
  const open = !fold || (expanded ?? keepReading);
  useLayoutEffect(() => {if (keepReading) setExpanded(true);}, [keepReading]);

  return <PilotReportFold id={id} bodyRef={body} open={open} automatic={fold && expanded === undefined}
    connected={connected} stripHidden={!fold} strip={
    <button type="button" className="pilot-report-toggle" aria-expanded={open}
      aria-controls={id} aria-describedby={`${id}-authors`} onClick={() => setExpanded(!open)}>
      {fold && <TaskSpecialistAvatars members={members} descriptionId={`${id}-authors`}/>}
      <span>{count} 份专员报告</span>
      <Glyph name="next" size={12} className="pilot-report-chevron"/>
    </button>}>
    {children}
  </PilotReportFold>;
}
