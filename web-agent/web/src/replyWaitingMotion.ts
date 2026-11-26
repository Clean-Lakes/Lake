import {useLayoutEffect, type RefObject} from 'react';

const pauseMs = 450;
const sweepMs = 1670;
const highlightRadius = 42;
const cursorSelector = '.specialist-reply-cursor';
const proseSelector = 'p,li,h1,h2,h3,h4,h5,h6';
const staticTextSelector = 'a,button,code,.object-reference';

type Line = {left: number; right: number; y: number; height: number};

function measureLines(paragraph: HTMLElement) {
  const bounds = paragraph.getBoundingClientRect();
  const doc = paragraph.ownerDocument;
  const walker = doc.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  const fragments: DOMRect[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue?.trim() || node.parentElement?.closest(staticTextSelector)) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width > 0 && rect.height > 0) fragments.push(rect);
    }
  }
  const lines: Line[] = [];
  for (const rect of fragments.sort((a, b) => a.top - b.top)) {
    const y = rect.top - bounds.top + rect.height / 2;
    const left = rect.left - bounds.left, right = rect.right - bounds.left;
    const previous = lines.at(-1);
    if (previous && Math.abs(previous.y - y) < Math.min(previous.height, rect.height) / 2) {
      previous.left = Math.min(left, previous.left);
      previous.right = Math.max(right, previous.right);
      previous.height = Math.max(previous.height, rect.height);
    } else {
      lines.push({left, right, y, height: rect.height});
    }
  }
  return lines;
}

function sweepImage(lines: Line[], progress: number, rtl: boolean) {
  const width = lines.reduce((total, line) => total + line.right - line.left, 0);
  let center = progress * (width + 2 * highlightRadius) - highlightRadius;
  const gradients: string[] = [];
  for (const line of lines) {
    const lineWidth = line.right - line.left;
    if (center > -highlightRadius && center < lineWidth + highlightRadius) {
      const x = rtl ? line.right - center : line.left + center;
      gradients.push(`radial-gradient(ellipse ${highlightRadius}px ${line.height * .7}px at ${x}px ${line.y}px, var(--reply-waiting-highlight), transparent)`);
    }
    center -= lineWidth;
  }
  return gradients.join(',');
}

/** Sweep the latest visible paragraph once, then sway its cursor while waiting. */
export function useReplyWaitingMotion(body: RefObject<HTMLElement | null>, source: string, active: boolean) {
  useLayoutEffect(() => {
    const root = body.current;
    if (!root || !active || !source.trim()) return;
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    if (!win) return;
    const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
    const forced = win.matchMedia('(forced-colors: active)');
    let timer = 0, frame = 0;
    let paragraph: HTMLElement | undefined;
    let cursor: HTMLElement | undefined;
    let swept = false;
    let lines: Line[] | undefined;
    const resize = new ResizeObserver(() => { lines = undefined; });

    const target = () => {
      const tail = root.querySelector<HTMLElement>(cursorSelector);
      const block = tail?.closest<HTMLElement>(proseSelector);
      return {tail, block: block && root.contains(block) ? block : root};
    };
    const clearSweep = () => {
      resize.disconnect();
      paragraph?.removeAttribute('data-reply-waiting-sweep');
      paragraph?.style.removeProperty('--reply-waiting-sweep');
      paragraph = undefined;
    };
    const stop = () => {
      win.clearTimeout(timer);
      win.cancelAnimationFrame(frame);
      clearSweep();
      cursor?.removeAttribute('data-reply-waiting-sway');
      cursor = undefined;
    };
    const startSway = (tail: HTMLElement | null) => {
      if (!tail) return;
      cursor = tail;
      cursor.setAttribute('data-reply-waiting-sway', '');
    };
    const start = () => {
      const {tail, block} = target();
      if (!tail) return;
      paragraph = block;
      const rtl = win.getComputedStyle(block).direction === 'rtl';
      lines = undefined;
      const startTime = win.performance.now();
      const paint = (now: number) => {
        const progress = (now - startTime) / sweepMs;
        lines ??= measureLines(block);
        if (progress >= 1 || !lines.length) {
          clearSweep();
          swept = true;
          startSway(tail);
          return;
        }
        const image = sweepImage(lines, progress, rtl);
        if (image) block.style.setProperty('--reply-waiting-sweep', image);
        block.toggleAttribute('data-reply-waiting-sweep', !!image);
        frame = win.requestAnimationFrame(paint);
      };
      resize.observe(block);
      frame = win.requestAnimationFrame(paint);
    };
    const schedule = () => {
      stop();
      if (doc.hidden || reduced.matches || forced.matches) return;
      if (swept) startSway(target().tail);
      else timer = win.setTimeout(start, pauseMs);
    };
    let previous = target();
    let displayed = previous.block.textContent;
    const observer = new MutationObserver(() => {
      const next = target();
      const text = next.block.textContent;
      if (previous.block === next.block && displayed === text && previous.tail === next.tail) return;
      const changed = displayed !== text;
      previous = next;
      displayed = text;
      if (changed) swept = false;
      schedule();
    });
    // The Markdown reveal can paint more text after the last transport packet.
    // Observe only the body, so tool status and output never reset its clock.
    observer.observe(root, {subtree: true, childList: true, characterData: true});
    doc.addEventListener('visibilitychange', schedule);
    reduced.addEventListener('change', schedule);
    forced.addEventListener('change', schedule);
    schedule();
    return () => {
      stop();
      observer.disconnect();
      doc.removeEventListener('visibilitychange', schedule);
      reduced.removeEventListener('change', schedule);
      forced.removeEventListener('change', schedule);
    };
  }, [body, source, active]);
}
