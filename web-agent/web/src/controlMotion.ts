export const controlMotionEase = "cubic-bezier(0.2, 0.8, 0.2, 1)";

export function canAnimateControls() {
  return !document.hidden && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
