import {useCallback, useEffect, useRef, useState} from 'react';

type Location = {url: URL; projectId: string | null};
type Entry = {key: string; index: number; projectId: string | null};
type Timeline = {key: string; last: number};
const field = 'lakeWorkspaceHistory';

function readEntry(state: unknown, timeline: Timeline | null): Entry | undefined {
  const entry = (state as {[field]?: Entry} | null)?.[field];
  if (timeline && entry?.key === timeline.key && Number.isInteger(entry.index) && entry.index >= 0 && entry.index <= timeline.last) {
    return entry;
  }
}

/** Track the same-document entries created by this workbench. */
export function useWorkspaceHistory(onPop: (projectId: string | null) => void) {
  const timeline = useRef<Timeline | null>(null);
  const traversing = useRef(false);
  const receive = useRef(onPop);
  receive.current = onPop;
  const [available, setAvailable] = useState({back: false, forward: false});

  useEffect(() => {
    const pop = (event: PopStateEvent) => {
      traversing.current = false;
      const entry = readEntry(event.state, timeline.current);
      setAvailable({back: (entry?.index ?? 0) > 0, forward: !!entry && entry.index < (timeline.current?.last ?? 0)});
      receive.current(entry?.projectId ?? null);
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  const push = useCallback((from: Location, to: Location) => {
    if (from.url.href === to.url.href && from.projectId === to.projectId) return;
    const history = window.history;
    const current = readEntry(history.state, timeline.current);
    const key = current?.key ?? `${Date.now()}-${Math.random()}`;
    const index = current?.index ?? 0;
    history.replaceState({...history.state, [field]: {key, index, projectId: from.projectId}}, '', from.url);
    history.pushState({[field]: {key, index: index + 1, projectId: to.projectId}}, '', to.url);
    timeline.current = {key, last: index + 1};
    traversing.current = false;
    setAvailable({back: true, forward: false});
  }, []);

  const step = (direction: -1 | 1) => {
    if (traversing.current) return;
    const entry = readEntry(window.history.state, timeline.current);
    if (entry && (direction < 0 ? entry.index > 0 : entry.index < (timeline.current?.last ?? 0))) {
      traversing.current = true;
      window.history.go(direction);
    }
  };

  return {available, push, step};
}
