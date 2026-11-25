const hideDelay = 1000;

export function initializeScrollbarVisibility(doc: Document = document) {
  const view = doc.defaultView;
  if (!view) return;

  const hideTimers = new WeakMap<Element, number>();
  doc.addEventListener("scroll", event => {
    const scroller = event.target === doc ? doc.scrollingElement : event.target;
    if (!(scroller instanceof view.Element)) return;

    const timer = hideTimers.get(scroller);
    if (timer !== undefined) view.clearTimeout(timer);
    if (scroller.getAttribute("data-scrollbar-activity") !== "scrolling") {
      scroller.setAttribute("data-scrollbar-activity", "scrolling");
    }
    hideTimers.set(scroller, view.setTimeout(() => {
      scroller.setAttribute("data-scrollbar-activity", "idle");
      hideTimers.delete(scroller);
    }, hideDelay));
  }, {capture: true, passive: true});
}
