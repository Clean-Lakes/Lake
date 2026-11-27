export type IslandPressState = 'idle' | 'squish' | 'swell';
export type IslandPhase = 'compact' | 'expanded';

export const ISLAND_PRESS_SWELL_MS = 110;
export const ISLAND_LONG_PRESS_MS = 260;
export const ISLAND_EXPANDED_WIDTH = 392;
export const ISLAND_DRAG_CANCEL_PX = 8;

const INTERACTIVE_DESCENDANT_SELECTOR =
  'button, a, input, select, textarea, summary, [role="button"], [role="menuitem"], .island-expand-drawer';

/** React portal events bubble through the island even when their DOM is outside it. */
export function isIslandPressTarget(target: EventTarget | null, islandRoot: Element): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const element = target as Element;
  return islandRoot.contains(element) && !element.closest(INTERACTIVE_DESCENDANT_SELECTOR);
}

/** Clamps the widened Dynamic Island width between its compact width and the pane budget. */
export function expandedIslandWidth(compactWidth: number, availableWidth: number): number {
  const safeCompact = Math.max(0, Math.ceil(compactWidth));
  const ceiling = Math.max(safeCompact, Math.floor(availableWidth));
  return Math.max(safeCompact, Math.min(ISLAND_EXPANDED_WIDTH, ceiling));
}

/** Centers the floating island horizontally inside its conversation pane while honoring side clearances. */
export function centeredIslandLeft(
  paneLeft: number,
  paneWidth: number,
  islandWidth: number,
  minLeft: number,
  maxRight: number,
): number {
  const ideal = Math.round(paneLeft + (paneWidth - islandWidth) / 2);
  const maxLeft = Math.max(minLeft, Math.floor(maxRight - islandWidth));
  return Math.max(minLeft, Math.min(maxLeft, ideal));
}
