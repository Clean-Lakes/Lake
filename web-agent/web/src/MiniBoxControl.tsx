import {useEffect,useLayoutEffect,useRef,useState} from 'react';

const bands=['tail','middle','head'] as const;

// SVG dash distances follow the actual rounded perimeter. Each band retains its
// CSS clock across output updates; measurements change only when the box resizes.
export function MiniBoxControl({active}:{active:boolean}) {
 const ref=useRef<HTMLSpanElement>(null);
 const [size,setSize]=useState({width:0,height:0});
 useLayoutEffect(()=>{
  const element=ref.current;if(!element)return;
  const measure=()=>{const width=element.clientWidth,height=element.clientHeight;if(width&&height)setSize(previous=>previous.width===width&&previous.height===height?previous:{width,height});};
  measure();const observer=new ResizeObserver(measure);observer.observe(element);
  return()=>observer.disconnect();
 },[]);
 useEffect(()=>{
  const sync=()=>{if(ref.current)ref.current.dataset.suspended=String(document.hidden);};
  sync();document.addEventListener('visibilitychange',sync);
  return()=>document.removeEventListener('visibilitychange',sync);
 },[]);
 return <span ref={ref} className="mini-box-control" data-active={active} aria-hidden="true"><span className="mini-box-control-flow"><svg viewBox={`0 0 ${size.width||1} ${size.height||1}`} preserveAspectRatio="none">{bands.map(band=><rect key={band} className={`mini-box-band-${band}`} x="1" y="1" width={Math.max(0,size.width-2)} height={Math.max(0,size.height-2)} rx="13" pathLength="100"/>)}</svg></span></span>;
}
