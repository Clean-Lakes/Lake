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
  onFold?: (settled: Promise<void>) => void;
  children: ReactNode;
};
type Geometry = {height: number; avatars: Map<string, {element: HTMLElement; bounds: DOMRect}>};

export class PilotReportFold extends Component<Props, object, Geometry | null> {
  private root = createRef<HTMLDivElement>();
  private strip = createRef<HTMLDivElement>();
  private flight = createRef<HTMLDivElement>();
  private stop?: () => void;

  getSnapshotBeforeUpdate(previous: Props): Geometry | null {
    const {automatic, open, connected, bodyRef} = this.props;
    const body = bodyRef.current;
    if (!previous.open || open || !automatic || !previous.connected || !connected || !body || document.hidden ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches || readingPilotReport(body) ||
        typeof body.animate !== 'function') return null;

    // Read the open stack before React adds the closed styling or the trigger.
    const bounds = body.getBoundingClientRect();
    const viewport = body.closest('.conversation')?.getBoundingClientRect();
    if (!bounds.height || bounds.bottom <= (viewport?.top ?? 0) || bounds.top >= (viewport?.bottom ?? window.innerHeight)) return null;
    const avatars: Geometry['avatars'] = new Map();
    for (const source of body.querySelectorAll<HTMLElement>('.response-avatar[data-report-avatar]')) {
      const key = source.dataset.reportAvatar!;
      if (!avatars.has(key)) avatars.set(key, {element: source, bounds: source.getBoundingClientRect()});
    }
    return {height: bounds.height, avatars};
  }

  componentDidUpdate(previous: Props, _state: object, geometry: Geometry | null) {
    if (this.props.open || !this.props.connected) this.stop?.();
    if (!geometry) return;
    const {bodyRef, onFold} = this.props;
    const body = bodyRef.current!, root = this.root.current!, strip = this.strip.current!, flight = this.flight.current!;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const timing = {duration: foldDuration, easing: foldEasing, fill: 'both'} as const;
    root.dataset.folding = '';
    const layer = flight.getBoundingClientRect();
    const animations: Animation[] = [];
    for (const target of strip.querySelectorAll<HTMLElement>('[data-report-avatar]')) {
      const origin = geometry.avatars.get(target.dataset.reportAvatar!);
      const icon = target.querySelector<HTMLElement>('.super-role-avatar');
      if (!origin?.bounds.width || !icon) continue;
      const destination = icon.getBoundingClientRect();
      if (!destination.width) continue;
      const clone = icon.cloneNode(true) as HTMLElement;
      clone.dataset.motion = 'still';
      clone.style.left = `${destination.left - layer.left}px`;
      clone.style.top = `${destination.top - layer.top}px`;
      clone.style.width = `${destination.width}px`;
      clone.style.height = `${destination.height}px`;
      flight.append(clone);
      animations.push(clone.animate([
        {transform: `translate(${origin.bounds.left - destination.left}px,${origin.bounds.top - destination.top}px) scale(${origin.bounds.width / destination.width})`},
        {transform: 'none'},
      ], timing));
      target.dataset.avatarLanding = '';
      origin.element.dataset.avatarLanding = '';
    }
    if (previous.stripHidden) {
      const height = `${strip.getBoundingClientRect().height}px`;
      animations.push(strip.animate([{height: '0px', opacity: 0}, {height, opacity: 1, offset: .78}, {height, opacity: 1}], timing));
    }
    const fold = body.animate([{height: `${geometry.height}px`, opacity: 1}, {height: '0px', opacity: 0}], timing);
    animations.push(fold);
    const stop = () => {
      if (this.stop !== stop) return;
      this.stop = undefined;
      for (const animation of animations) animation.cancel();
      delete root.dataset.folding;
      for (const target of root.querySelectorAll<HTMLElement>('[data-avatar-landing]')) delete target.dataset.avatarLanding;
      for (const {element} of geometry.avatars.values()) delete element.dataset.avatarLanding;
      flight.replaceChildren();
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
    const {id, bodyRef, open, strip, stripHidden, children} = this.props;
    return <div ref={this.root} className="pilot-report-fold" onFocusCapture={() => this.stop?.()}>
      <div ref={this.strip} className="pilot-report-strip" hidden={stripHidden}>{strip}</div>
      <div ref={bodyRef} id={id} className="pilot-report-body" aria-hidden={!open || undefined} inert={!open}>
        <div className="pilot-report-items">{children}</div>
      </div>
      <div ref={this.flight} className="pilot-report-flight" inert aria-hidden="true"/>
    </div>;
  }
}
