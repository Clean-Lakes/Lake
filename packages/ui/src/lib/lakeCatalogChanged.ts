const LAKE_CATALOG_CHANGED_EVENT = "lake-catalog-changed";

export function notifyLakeCatalogChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LAKE_CATALOG_CHANGED_EVENT));
}

export function addLakeCatalogChangedListener(listener: () => void): () => void {
  window.addEventListener(LAKE_CATALOG_CHANGED_EVENT, listener);
  return () => window.removeEventListener(LAKE_CATALOG_CHANGED_EVENT, listener);
}
