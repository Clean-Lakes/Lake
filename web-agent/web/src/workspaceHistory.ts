import {useCallback, useEffect, useRef, useState} from 'react';

type Location = {url: URL; projectId: string | null};
type Entry = {key: string; index: number; projectId: string | null};
type Timeline = {key: string; index: number; last: number};
const field = 'lakeWorkspaceHistory';

function readEntry(state: unknown, timeline: Timeline | null): Entry | undefined {
  const entry = (state as {[field]?: Entry} | null)?.[field];
  if (timeline && entry?.key === timeline.key && Number.isInteger(entry.index) && entry.index >= 0 && entry.index <= timeline.last) {
    return entry;
  }
}

/** Track the same-document entries created by this workbench. */
export function useWorkspaceHistory(onPop: (projectId: string | null) => void, confirmTraversal?: () => boolean | Promise<boolean>) {
  const timeline = useRef<Timeline | null>(null);
  const traversing = useRef(false);
  const awaitingConfirmation = useRef(false);
  const confirm = useRef(confirmTraversal);
  confirm.current = confirmTraversal;
  const receive = useRef(onPop);
  receive.current = onPop;
  const [available, setAvailable] = useState({back: false, forward: false});

  useEffect(() => {
    const accept = () => {
      traversing.current = false;
      const entry = readEntry(window.history.state, timeline.current);
      if (entry && timeline.current) timeline.current.index = entry.index;
      setAvailable({back: (entry?.index ?? 0) > 0, forward: !!entry && entry.index < (timeline.current?.last ?? 0)});
      receive.current(entry?.projectId ?? null);
    };
    const pop = (event: PopStateEvent) => {
      if (awaitingConfirmation.current) return;
      const origin = timeline.current;
      const target = readEntry(event.state, origin);
      if (!origin || !target || origin.index === target.index) { accept(); return; }
      const permission = confirm.current?.() ?? true;
      if (permission === true) { accept(); return; }
      awaitingConfirmation.current = true;
      void Promise.resolve(permission).then(allowed => {
        awaitingConfirmation.current = false;
        if (allowed) { accept(); return; }
        // The browser moved before popstate. Restore the committed index if the user stays.
        const current = readEntry(window.history.state, origin);
        if (current && current.index !== origin.index) {
          traversing.current = true;
          window.history.go(origin.index - current.index);
        } else traversing.current = false;
      });
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  const replace = useCallback((to: Location) => {
    const history = window.history;
    const entry = readEntry(history.state, timeline.current);
    const state = entry ? {...history.state, [field]: {...entry, projectId: to.projectId}} : history.state;
    history.replaceState(state, '', to.url);
  }, []);

  const push = useCallback((from: Location, to: Location) => {
    if (from.url.href === to.url.href && from.projectId === to.projectId) return;
    const history = window.history;
    const current = readEntry(history.state, timeline.current);
    const key = current?.key ?? `${Date.now()}-${Math.random()}`;
    const index = current?.index ?? 0;
    history.replaceState({...history.state, [field]: {key, index, projectId: from.projectId}}, '', from.url);
    history.pushState({[field]: {key, index: index + 1, projectId: to.projectId}}, '', to.url);
    timeline.current = {key, index: index + 1, last: index + 1};
    traversing.current = false;
    setAvailable({back: true, forward: false});
  }, []);

  const step = (direction: -1 | 1) => {
    if (traversing.current || awaitingConfirmation.current) return;
    const entry = readEntry(window.history.state, timeline.current);
    if (entry && (direction < 0 ? entry.index > 0 : entry.index < (timeline.current?.last ?? 0))) {
      traversing.current = true;
      window.history.go(direction);
    }
  };

  return {available, push, replace, step};
}
