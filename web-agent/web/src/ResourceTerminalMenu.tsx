import {useLayoutEffect, useState, type ReactNode, type RefObject} from "react";
import {createPortal} from "react-dom";

/** Keep terminal management outside the narrow, scrolling resource tree. */
export function ResourceTerminalMenu({anchor, menuRef, label, children}: {anchor: RefObject<HTMLDivElement | null>; menuRef: RefObject<HTMLDivElement | null>; label: string; children: ReactNode}) {
  const [position, setPosition] = useState<{left: number; top: number; width: number} | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const trigger = anchor.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 24);
      const right = rect.right + 12;
      const left = right + width <= window.innerWidth - 12 ? right : Math.max(12, rect.left - width - 12);
      const top = Math.max(12, Math.min(rect.top, window.innerHeight - menu.offsetHeight - 12));
      setPosition(current => current?.left === left && current.top === top && current.width === width ? current : {left, top, width});
    };
    place();
    const observer = new ResizeObserver(place);
    if (menuRef.current) observer.observe(menuRef.current);
    if (anchor.current) observer.observe(anchor.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor, menuRef]);
  useLayoutEffect(() => {
    if (position) menuRef.current?.querySelector<HTMLButtonElement>(".resource-open-terminal:not(:disabled)")?.focus({preventScroll: true});
  }, [!!position, menuRef]);
  return createPortal(<div ref={menuRef} className="resource-terminal-menu" role="group" aria-label={label} style={{left: position?.left ?? 12, top: position?.top ?? 12, width: position?.width ?? 320, visibility: position ? "visible" : "hidden"}}>{children}</div>, document.body);
}
