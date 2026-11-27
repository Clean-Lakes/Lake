import {useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject} from 'react';
import {createPortal} from 'react-dom';

const reducedMotion = '(prefers-reduced-motion: reduce)';
export const workbenchModalMotion: KeyframeAnimationOptions = {
  duration: 180,
  easing: 'cubic-bezier(.2,.7,.2,1)',
  fill: 'both',
};

/** Modal dialog sharing WorkspaceConsole's entrance and reverse-on-close motion. */
export function WorkbenchModalDialog({className, labelledBy, busy = false, returnFocus, initialFocus, onClose, children}: {
  className: string;
  labelledBy: string;
  busy?: boolean;
  returnFocus: RefObject<HTMLElement | null>;
  initialFocus?: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: (requestClose: (force?: boolean) => void) => ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const appearance = useRef<Animation[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const closingRef = useRef(false);
  const finishedRef = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  const initialFocusRef = useRef(initialFocus);
  initialFocusRef.current = initialFocus;
  const [closing, setClosing] = useState(false);

  const clearAppearance = () => {
    for (const animation of appearance.current) animation.cancel();
    appearance.current = [];
  };

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    controllerRef.current?.abort();
    dialog.current?.close();
    clearAppearance();
    const trigger = returnFocusRef.current.current;
    if (trigger?.isConnected) trigger.focus({preventScroll: true});
    onCloseRef.current();
  }, []);

  useLayoutEffect(() => {
    const node = dialog.current;
    const shade = scrim.current;
    const panel = frame.current;
    if (!node || !shade || !panel) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    const motion = window.matchMedia(reducedMotion);
    const shouldSkip = () => document.hidden || motion.matches;

    if (!node.open) node.showModal();
    initialFocusRef.current?.current?.focus({preventScroll: true});
    if (!shouldSkip() && typeof panel.animate === 'function') {
      appearance.current = [
        shade.animate([{opacity: 0}, {opacity: 1}], workbenchModalMotion),
        panel.animate([{opacity: 0, transform: 'translateY(5px)'}, {opacity: 1, transform: 'none'}], workbenchModalMotion),
      ];
    }

    const skipMotion = () => {
      if (!shouldSkip()) return;
      if (closingRef.current) finish();
      else clearAppearance();
    };
    motion.addEventListener('change', skipMotion, {signal: controller.signal});
    document.addEventListener('visibilitychange', skipMotion, {signal: controller.signal});

    return () => {
      controller.abort();
      clearAppearance();
      node.close();
      const trigger = returnFocusRef.current.current;
      if (!finishedRef.current && trigger?.isConnected) trigger.focus({preventScroll: true});
    };
  }, [finish]);

  const requestClose = useCallback((force = false) => {
    if ((!force && busyRef.current) || closingRef.current || finishedRef.current) return;
    closingRef.current = true;
    setClosing(true);
    const shouldSkip = document.hidden || window.matchMedia(reducedMotion).matches;
    const animations = appearance.current;
    // Before the first painted entrance frame there is nothing to reverse.
    if (shouldSkip || !animations.some(animation => Number(animation.currentTime) > 0)) {
      finish();
      return;
    }
    for (const animation of animations) animation.reverse();
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (!controllerRef.current?.signal.aborted) finish();
    });
  }, [finish]);

  return createPortal(<dialog ref={dialog} role="dialog" className="workbench-modal-shell" aria-labelledby={labelledBy}
    onCancel={event => {
      event.preventDefault();
      if (event.target === event.currentTarget) requestClose();
    }}
    onClick={event => {
      if (event.target === event.currentTarget) requestClose();
    }}>
    <div ref={scrim} className="workbench-modal-scrim" aria-hidden="true"/>
    <div ref={frame} className={`modal workbench-dialog ${className}`} inert={closing}>
      {children(requestClose)}
    </div>
  </dialog>, document.body);
}
