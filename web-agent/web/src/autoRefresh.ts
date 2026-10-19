export type RefreshEnvironment = {
  visible: () => boolean;
  wake: (callback: () => void) => () => void;
  every: (callback: () => void, milliseconds: number) => () => void;
};

// Manual refresh supersedes a pending poll. Even a transport that ignores abort
// cannot apply an older response after a selection/save or after unmounting.
export function startAutoRefresh<T>(read: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void, environment: RefreshEnvironment, onError: (error: unknown) => void = () => {}) {
  let stopped = false;
  let pending: AbortController | null = null;
  async function refresh(manual = false) {
    if (stopped || (!manual && (!environment.visible() || pending))) return;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    try {
      const value = await read(signal);
      if (!stopped && pending === controller && !signal.aborted) apply(value);
    } catch (error) {
      if (stopped || pending !== controller || controller.signal.aborted) return;
      if (manual) throw error;
      onError(error);
    } finally {
      if (pending === controller) pending = null;
    }
  }
  const removeWake = environment.wake(() => { void refresh(); });
  const removeTimer = environment.every(() => { void refresh(); }, 2000);
  void refresh();
  return {
    refresh: () => refresh(true),
    stop: () => { stopped = true; pending?.abort(); removeWake(); removeTimer(); },
  };
}
