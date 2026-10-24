import {useEffect, useRef, useState} from 'react';
import type {SessionSnapshot, TerminalHistory} from '../../shared/contracts';
import {api, ApiRequestError} from './api';
import {executionEntries, latestExecution, sshExecutionScope} from './sshExecution';

export function useSSHExecution(snapshot: SessionSnapshot | null, connected: boolean, revision: number) {
  const scope = sshExecutionScope(snapshot);
  const key = scope?.key ?? '';
  const terminals = JSON.stringify(scope?.terminals.map(({id, generation, resourceId}) => ({id, generation, resourceId})) ?? []);
  const [state, setState] = useState<{key: string; histories: TerminalHistory[]; stale: boolean}>({key: '', histories: [], stale: false});
  const refreshRef = useRef(() => {});
  const running = scope?.running ?? false;
  useEffect(() => {
    if (!scope || !connected) return;
    const {session, startedAt} = scope;
    const candidates = JSON.parse(terminals) as Array<{id: string; generation: string; resourceId: string}>;
    const controller = new AbortController();
    let disposed = false, syncing = false, queued = false;
    const refresh = async () => {
      if (disposed || document.hidden) return;
      if (syncing) { queued = true; return; }
      syncing = true;
      const results = await Promise.allSettled(candidates.map(async terminal => {
        const history = await api.terminalHistory(session, terminal.id, controller.signal);
        if (history.terminal.id !== terminal.id || history.terminal.generation !== terminal.generation || history.terminal.resourceId !== terminal.resourceId) return null;
        return {...history, output: '', entries: executionEntries(history, session, startedAt)};
      }));
      if (!disposed) {
        setState(previous => {
          const histories = results.flatMap((result, index) => {
            if (result.status === 'fulfilled') return result.value?.entries.length ? [result.value] : [];
            // Preserve displayed output across a transport failure, never across
            // turns or terminal generations. Failed reads cannot signal activity.
            const denied = result.reason instanceof ApiRequestError && [401, 403, 404, 409].includes(result.reason.status);
            return !denied && previous.key === key ? previous.histories.filter(history => history.terminal.id === candidates[index]!.id && history.terminal.generation === candidates[index]!.generation) : [];
          });
          return {key, histories, stale: results.some(result => result.status === 'rejected')};
        });
      }
      syncing = false;
      if (queued && !disposed) { queued = false; void refresh(); }
    };
    refreshRef.current = () => { void refresh(); };
    void refresh();
    // Terminal SSE revisions normally drive updates; this bounded fallback also
    // covers adopted terminals whose owner has a different event stream.
    const timer = running ? setInterval(() => void refresh(), 750) : undefined;
    const visibility = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true; controller.abort(); clearInterval(timer);
      refreshRef.current = () => {};
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [key, terminals, connected, running]);
  useEffect(() => { refreshRef.current(); }, [revision]);
  const histories = state.key === key ? state.histories : [];
  return {key, histories, history: latestExecution(histories), stale: !connected || state.stale};
}
