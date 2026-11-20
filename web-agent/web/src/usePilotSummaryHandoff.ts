import {useContext, useLayoutEffect, useRef, useState} from 'react';
import {PilotReportFolds, readingPilotReport} from './PilotReportFold';

type Summary = {id: string; roundId: string; connected: boolean};
type Shown = {id?: string; fromHeight?: number};

/** Present a delivered summary in the already mounted acknowledgement. */
export function usePilotSummaryHandoff({id, roundId, connected}: Partial<Summary>) {
  const body = useRef<HTMLDivElement>(null);
  const arrived = useRef<string>(undefined);
  const folds = useContext(PilotReportFolds);
  const [shown, setShown] = useState<Shown>(() => ({id}));
  const visible = !!id && shown.id === id;

  useLayoutEffect(() => {
    const element = body.current;
    if (!element || !id || visible) return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const permitsMotion = () => connected && !media.matches && !document.hidden &&
      typeof element.animate === 'function' && !readingPilotReport(element);
    const canAnimateHere = () => {
      const rect = element.getBoundingClientRect();
      const viewport = element.closest('.conversation')?.getBoundingClientRect();
      return permitsMotion() && rect.height > 0 && rect.bottom > (viewport?.top ?? 0) &&
        rect.top < (viewport?.bottom ?? window.innerHeight);
    };
    if (!permitsMotion()) {
      setShown({id});
      return;
    }

    let cancelled = false;
    let departure: Animation | undefined;
    const showNow = () => {
      if (cancelled) return;
      cancelled = true;
      departure?.cancel();
      setShown({id});
    };
    // The report stack registers its fold during the same commit.
    const frame = requestAnimationFrame(async () => {
      await (roundId ? folds?.get(roundId) : undefined);
      if (cancelled) return;
      if (!canAnimateHere()) {
        showNow();
        return;
      }
      const fromHeight = element.getBoundingClientRect().height;
      departure = element.animate([
        {opacity: 1, transform: 'none'},
        {opacity: .24, transform: 'translateY(-3px)'},
      ], {duration: 110, easing: 'ease-in', fill: 'both'});
      void departure.finished.then(() => {
        if (!cancelled) setShown({id, fromHeight});
      }, () => {});
    });
    media.addEventListener('change', showNow);
    document.addEventListener('visibilitychange', showNow);
    element.addEventListener('focusin', showNow);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      departure?.cancel();
      media.removeEventListener('change', showNow);
      document.removeEventListener('visibilitychange', showNow);
      element.removeEventListener('focusin', showNow);
    };
  }, [connected, folds, id, roundId, visible]);

  useLayoutEffect(() => {
    const element = body.current;
    if (!element || !visible || shown.fromHeight === undefined || arrived.current === shown.id) return;
    arrived.current = shown.id;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!connected || media.matches || document.hidden || readingPilotReport(element)) return;
    const arrival = element.animate([
      {opacity: .48, transform: 'translateY(3px)', minHeight: `${shown.fromHeight}px`},
      {opacity: 1, transform: 'none', minHeight: '0px'},
    ], {duration: 230, easing: 'cubic-bezier(.32,.15,.22,1)'});
    const stop = () => {
      arrival.cancel();
      media.removeEventListener('change', stop);
      document.removeEventListener('visibilitychange', stop);
      element.removeEventListener('focusin', stop);
    };
    media.addEventListener('change', stop);
    document.addEventListener('visibilitychange', stop);
    element.addEventListener('focusin', stop);
    void arrival.finished.then(stop, stop);
    return stop;
  }, [connected, visible, shown]);

  return {body, visible, reveal: visible && shown.fromHeight !== undefined};
}
