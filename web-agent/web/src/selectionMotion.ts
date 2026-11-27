import {canAnimateControls} from './controlMotion';

// The Bento Card spring at 600 ms with 0.2 bounce, sampled every 30 ms.
export const selectionSpring =
  'linear(0,.0794,.2486,.4375,.6093,.7484,.8518,.9231,.9688,.9954,1.0091,1.0144,1.015,1.0131,1.0104,1.0076,1.0051,1.0032,1.0018,1.0009,1)';
export const selectionSpringFallback = 'cubic-bezier(.2,.85,.3,1)';
export const selectionSpringDuration = 600;

export type SelectionAxis = 'x' | 'y' | 'both';

export type AlignSelectionOptions = {
  axis?: SelectionAxis;
  animate?: boolean;
  reveal?: boolean;
  key?: string;
  topVar?: string;
  leftVar?: string;
};

export function selectionSpringTiming(): KeyframeAnimationOptions {
  const supportsLinear =
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('animation-timing-function', selectionSpring);
  return {
    duration: selectionSpringDuration,
    fill: 'backwards',
    easing: supportsLinear ? selectionSpring : selectionSpringFallback,
  };
}

export function cancelSelectionMotion(indicator: HTMLElement) {
  indicator.getAnimations?.().forEach(animation => animation.cancel());
}

function roundPx(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function alignSelectionIndicator(
  container: HTMLElement,
  indicator: HTMLElement,
  target: HTMLElement | null,
  options: AlignSelectionOptions = {},
) {
  if (!target) {
    container.removeAttribute('data-selection-visible');
    indicator.removeAttribute('data-ready');
    delete indicator.dataset.selectionKey;
    cancelSelectionMotion(indicator);
    return;
  }

  const axis = options.axis ?? 'both';
  const leftVar = options.leftVar ?? '--selection-left';
  const topVar = options.topVar ?? '--selection-top';
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (!targetRect.width && !targetRect.height) {
    container.removeAttribute('data-selection-visible');
    indicator.removeAttribute('data-ready');
    delete indicator.dataset.selectionKey;
    cancelSelectionMotion(indicator);
    return;
  }
  const scrollLeft = container.scrollLeft;
  const scrollTop = container.scrollTop;
  const originLeft = containerRect.left + container.clientLeft - scrollLeft;
  const originTop = containerRect.top + container.clientTop - scrollTop;
  const left = roundPx(targetRect.left - originLeft);
  const top = roundPx(targetRect.top - originTop);
  const width = roundPx(targetRect.width);
  const height = roundPx(targetRect.height);

  const visible =
    container.hasAttribute('data-selection-visible') &&
    (axis === 'y' || indicator.hasAttribute('data-ready'));

  const atTarget =
    visible &&
    (axis === 'y'
      ? indicator.style.getPropertyValue(topVar) === `${top}px` &&
        indicator.style.height === `${height}px`
      : axis === 'x'
        ? indicator.style.getPropertyValue(leftVar) === `${left}px` &&
          indicator.style.width === `${width}px`
        : indicator.style.getPropertyValue(leftVar) === `${left}px` &&
          indicator.style.getPropertyValue(topVar) === `${top}px` &&
          indicator.style.width === `${width}px` &&
          indicator.style.height === `${height}px`);

  const nextKey = options.key ?? target.id ?? '';
  const previousKey = indicator.dataset.selectionKey;
  const moving =
    Boolean(options.animate) &&
    !atTarget &&
    visible &&
    previousKey !== undefined &&
    previousKey !== nextKey &&
    typeof indicator.animate === 'function' &&
    canAnimateControls();

  // Read the painted position before cancelling an interrupted slide or scrolling.
  const from = moving ? indicator.getBoundingClientRect() : null;

  if (options.reveal) {
    if (top < scrollTop) container.scrollTop = top;
    else if (top + height > scrollTop + container.clientHeight) {
      container.scrollTop = top + height - container.clientHeight;
    }
  }

  indicator.dataset.selectionKey = nextKey;
  if (atTarget) return;

  cancelSelectionMotion(indicator);
  indicator.style.setProperty(leftVar, `${left}px`);
  indicator.style.setProperty(topVar, `${top}px`);
  indicator.style.setProperty('--selection-width', `${width}px`);
  indicator.style.setProperty('--selection-height', `${height}px`);
  if (axis === 'y' || axis === 'both') indicator.style.height = `${height}px`;
  if (axis === 'x' || axis === 'both') indicator.style.width = `${width}px`;
  indicator.setAttribute('data-ready', 'true');
  container.setAttribute('data-selection-visible', '');

  if (!from) return;

  const timing = selectionSpringTiming();
  if (axis === 'y') {
    if (!height) return;
    const fromTop = from.top - originTop;
    indicator.animate(
      [
        {transform: `translate3d(0,${fromTop}px,0) scaleY(${from.height / height})`},
        {transform: `translate3d(0,${top}px,0) scaleY(1)`},
      ],
      timing,
    );
    return;
  }

  if (axis === 'x') {
    if (!width) return;
    const fromLeft = from.left - originLeft;
    indicator.animate(
      [
        {transform: `translate3d(${fromLeft}px,0,0) scaleX(${from.width / width})`},
        {transform: `translate3d(${left}px,0,0) scaleX(1)`},
      ],
      timing,
    );
    return;
  }

  if (!width || !height) return;
  const fromLeft = from.left - originLeft;
  const fromTop = from.top - originTop;
  indicator.animate(
    [
      {
        transform: `translate3d(${fromLeft}px,${fromTop}px,0) scale(${from.width / width},${from.height / height})`,
      },
      {transform: `translate3d(${left}px,${top}px,0) scale(1,1)`},
    ],
    timing,
  );
}
