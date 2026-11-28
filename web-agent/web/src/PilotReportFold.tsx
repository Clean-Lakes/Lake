import {Component, createContext, createRef, useState, type ReactNode, type RefObject} from 'react';

export const PilotReportFolds = createContext<Map<string, Promise<void>> | null>(null);

export function PilotReportFoldScope({children}: {children: ReactNode}) {
  const [folds] = useState(() => new Map<string, Promise<void>>());
  return <PilotReportFolds.Provider value={folds}>{children}</PilotReportFolds.Provider>;
}

export function readingPilotReport(body: HTMLElement | null) {
  if (!body) return false;
  const selection = window.getSelection();
  return body.contains(document.activeElement) || !!selection && !selection.isCollapsed &&
    (body.contains(selection.anchorNode) || body.contains(selection.focusNode));
}

const foldDuration = 480;
const foldEasing = 'cubic-bezier(.32,.15,.22,1)';

type Props = {
  id: string;
  bodyRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  automatic: boolean;
  connected: boolean;
  strip: ReactNode;
  stripHidden?: boolean;
  immediate?: boolean;
  onFold?: (settled: Promise<void>) => void;
  children: ReactNode;
};
type FoldSnapshot = number | 'restore-focus' | null;

export class PilotReportFold extends Component<Props, object, FoldSnapshot> {
  private root = createRef<HTMLDivElement>();
  private strip = createRef<HTMLDivElement>();
  private stop?: () => void;

  getSnapshotBeforeUpdate(previous: Props): FoldSnapshot {
    const {automatic, open, connected, bodyRef, immediate} = this.props;
    const body = bodyRef.current;
    if (!previous.open || open || !body) return null;
    if (immediate) return body.contains(document.activeElement) ? 'restore-focus' : null;
    if (!automatic || !previous.connected || !connected || document.hidden ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches || readingPilotReport(body) ||
        typeof body.animate !== 'function') return null;

    // Read the open stack before React adds the closed styling or the trigger.
    const bounds = body.getBoundingClientRect();
    const viewport = body.closest('.conversation')?.getBoundingClientRect();
    if (!bounds.height || bounds.bottom <= (viewport?.top ?? 0) || bounds.top >= (viewport?.bottom ?? window.innerHeight)) return null;
    return bounds.height;
  }

  componentDidUpdate(previous: Props, _state: object, previousHeight: FoldSnapshot) {
    if (this.props.open || !this.props.connected) this.stop?.();
    if (previousHeight === null) return;
    if (previousHeight === 'restore-focus') {
      this.strip.current?.querySelector('button')?.focus({preventScroll: true});
      return;
    }
    const {bodyRef, onFold} = this.props;
    const body = bodyRef.current!, root = this.root.current!, strip = this.strip.current!;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const timing = {duration: foldDuration, easing: foldEasing, fill: 'both'} as const;
    root.dataset.folding = '';
    const animations: Animation[] = [];
    // The disclosure stays in place. Only its avatars settle when reports fold.
    strip.querySelectorAll<HTMLElement>('[data-report-avatar]').forEach((avatar, index) => {
      animations.push(avatar.animate([
        {transform: 'translateY(-4px) scale(.94)', opacity: .45},
        {transform: 'none', opacity: 1},
      ], {duration: 250, delay: (previous.stripHidden ? 100 : 0) + index * 38,
        easing: 'cubic-bezier(.22,.78,.28,1)', fill: 'both'}));
    });
    if (previous.stripHidden) {
      const height = `${strip.getBoundingClientRect().height}px`;
      animations.push(strip.animate([{height: '0px', opacity: 0}, {height, opacity: 1, offset: .78}, {height, opacity: 1}], timing));
    }
    const fold = body.animate([{height: `${previousHeight}px`, opacity: 1}, {height: '0px', opacity: 0}], timing);
    animations.push(fold);
    const stop = () => {
      if (this.stop !== stop) return;
      this.stop = undefined;
      for (const animation of animations) animation.cancel();
      delete root.dataset.folding;
      document.removeEventListener('visibilitychange', stop);
      window.removeEventListener('resize', stop);
      media.removeEventListener('change', stop);
    };
    this.stop = stop;
    const settled = fold.finished.then(stop, stop);
    onFold?.(settled);
    document.addEventListener('visibilitychange', stop);
    window.addEventListener('resize', stop);
    media.addEventListener('change', stop);
  }

  componentWillUnmount() {
    this.stop?.();
  }

  render() {
    const {id, bodyRef, open, strip, stripHidden, immediate, children} = this.props;
    return <div ref={this.root} className="pilot-report-fold" onFocusCapture={() => this.stop?.()}>
      <div ref={this.strip} className="pilot-report-strip" hidden={stripHidden}>{strip}</div>
      <div ref={bodyRef} id={id} className="pilot-report-body" aria-hidden={!open || undefined} inert={!open} hidden={immediate&&!open}>
        <div className="pilot-report-items">{children}</div>
      </div>
    </div>;
  }
}
