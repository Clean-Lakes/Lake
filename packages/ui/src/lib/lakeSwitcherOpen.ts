const LAKE_SWITCHER_OPEN_EVENT = "lake-switcher-open";

export function requestLakeSwitcherOpen(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LAKE_SWITCHER_OPEN_EVENT));
}

export function addLakeSwitcherOpenListener(listener: () => void): () => void {
  window.addEventListener(LAKE_SWITCHER_OPEN_EVENT, listener);
  return () => window.removeEventListener(LAKE_SWITCHER_OPEN_EVENT, listener);
}
