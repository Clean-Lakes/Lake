import {useCallback, useEffect, useRef} from "react";
import {startAutoRefresh, type RefreshEnvironment} from "./autoRefresh";

const browserEnvironment: RefreshEnvironment = {
  visible: () => !document.hidden,
  wake: callback => {
    window.addEventListener("focus", callback);
    document.addEventListener("visibilitychange", callback);
    return () => { window.removeEventListener("focus", callback); document.removeEventListener("visibilitychange", callback); };
  },
  every: (callback, milliseconds) => {
    const timer = window.setInterval(callback, milliseconds);
    return () => window.clearInterval(timer);
  },
};

export function useAutoRefresh<T>(read: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void, enabled = true, onError?: (error: unknown) => void) {
  const callbacks = useRef({read, apply, onError});
  callbacks.current = {read, apply, onError};
  const controller = useRef<ReturnType<typeof startAutoRefresh<T>> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const refresh = startAutoRefresh(signal => callbacks.current.read(signal), value => callbacks.current.apply(value), browserEnvironment, error => callbacks.current.onError?.(error));
    controller.current = refresh;
    return () => { refresh.stop(); controller.current = null; };
  }, [enabled]);
  return useCallback(async () => { await controller.current?.refresh(); }, []);
}
