import {useLayoutEffect,useState,type RefObject} from 'react';

const reduceMotion = '(prefers-reduced-motion: reduce)';

// AccordionOS timing, with a painted reveal so growing Markdown keeps its natural size.
export function animateReplyEntrance(surface: Pick<HTMLElement,'animate'>): [Animation, Animation, Animation, Animation] {
  return [
    surface.animate([
      {clipPath:'inset(0% -4px 100% -4px)'},
      {clipPath:'inset(0% -4px -4px -4px)'},
    ], {duration:400,easing:'cubic-bezier(.16,1,.3,1)',fill:'backwards'}),
    surface.animate([{opacity:0},{opacity:1}], {duration:300,delay:80,easing:'ease-out',fill:'backwards'}),
    surface.animate([{filter:'blur(4px)'},{filter:'blur(0px)'}], {duration:300,easing:'ease-out',fill:'backwards'}),
    surface.animate([{transform:'translateY(8px)'},{transform:'translateY(0)'}], {duration:300,delay:50,easing:'ease-out',fill:'backwards'}),
  ];
}

export function useReplyEntrance(body: RefObject<HTMLDivElement|null>, arrive: boolean) {
  const [opening] = useState(arrive);
  useLayoutEffect(() => {
    const surface = body.current;
    if (!opening || !surface || typeof surface.animate !== 'function') return;
    const media = window.matchMedia(reduceMotion);
    if (document.hidden || media.matches || surface.contains(document.activeElement)) return;
    const animations = animateReplyEntrance(surface);
    const stop = () => {
      animations[0].onfinish = null;
      animations.forEach(animation => animation.cancel());
      document.removeEventListener('visibilitychange',stop);
      media.removeEventListener('change',stop);
      surface.removeEventListener('focusin',stop);
    };
    animations[0].onfinish = stop;
    document.addEventListener('visibilitychange',stop);
    media.addEventListener('change',stop);
    surface.addEventListener('focusin',stop);
    return stop;
  }, [body,opening]);
}
