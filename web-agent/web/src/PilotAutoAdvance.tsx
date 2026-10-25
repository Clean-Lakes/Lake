import {useEffect,useId,useRef,useState,type CSSProperties} from 'react';
import {Glyph} from './Icons';

export function PilotAutoAdvance({enabled,disabled,busy,error,onCommit}:{enabled:boolean;disabled:boolean;busy:boolean;error?:string;onCommit:(enabled:boolean)=>Promise<boolean>}){
 const initial=enabled?100:0;
 const [value,setValue]=useState(initial),[dragging,setDragging]=useState(false);
 const track=useRef<HTMLDivElement>(null),gesture=useRef<{id:number;x:number;start:number;travel:number}|null>(null),valueRef=useRef(initial),pending=useRef(false),actual=useRef(enabled);
 actual.current=enabled;
 const hint=useId();
 const move=(next:number)=>{valueRef.current=next;setValue(next)};
 const reset=()=>{gesture.current=null;setDragging(false);move(actual.current?100:0)};
 useEffect(()=>{gesture.current=null;setDragging(false);valueRef.current=initial;setValue(initial)},[enabled,disabled]);
 const commit=async()=>{
  if(disabled||busy||pending.current)return;
  const next=valueRef.current>=99?true:valueRef.current<=1?false:enabled;
  if(next===enabled){reset();return}
  pending.current=true;
  try{await onCommit(next)}finally{pending.current=false;reset()}
 };
 return <div className="pilot-auto-advance" role="group" aria-label="自动推进">
  <div ref={track} className={`pilot-auto-track${dragging?' is-dragging':''}`} data-enabled={enabled} data-disabled={disabled||busy} style={{'--pilot-slide':value/100} as CSSProperties}>
   <span className="pilot-auto-stops" aria-hidden="true"><i/><i/></span>
   <button type="button" role="slider" aria-label="自动推进" title={disabled?'连接恢复后可调整自动推进。':enabled?'自动推进已开启，向左滑动关闭。仅对新任务生效，变更仍按权限确认。':'向右滑动解锁自动推进。仅对新任务生效，变更仍按权限确认。'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)} aria-valuetext={busy?'正在保存':value===initial?(enabled?'已开启':'已关闭'):`滑动 ${Math.round(value)}%，到达端点后确认`} aria-describedby={hint} aria-disabled={disabled||busy} aria-busy={busy} disabled={disabled} className="pilot-auto-thumb"
    onPointerDown={event=>{if(disabled||busy||pending.current||event.button!==0||gesture.current)return;const width=track.current?.clientWidth??0;const travel=width-event.currentTarget.offsetWidth+4;if(travel<=0)return;event.preventDefault();event.currentTarget.focus({preventScroll:true});event.currentTarget.setPointerCapture(event.pointerId);gesture.current={id:event.pointerId,x:event.clientX,start:valueRef.current,travel};setDragging(true)}}
    onPointerMove={event=>{const g=gesture.current;if(g&&g.id===event.pointerId)move(Math.max(0,Math.min(100,g.start+(event.clientX-g.x)/g.travel*100)))}}
    onPointerUp={event=>{const g=gesture.current;if(g?.id!==event.pointerId)return;move(Math.max(0,Math.min(100,g.start+(event.clientX-g.x)/g.travel*100)));gesture.current=null;setDragging(false);event.currentTarget.releasePointerCapture(event.pointerId);void commit()}}
    onPointerCancel={reset} onLostPointerCapture={()=>{if(gesture.current)reset()}}
    onBlur={()=>{if(!pending.current)reset()}}
    onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();reset();return}if(disabled||busy||pending.current)return;if(['ArrowLeft','ArrowRight','Home','End','Enter',' '].includes(event.key)){event.preventDefault();event.stopPropagation();if(event.key==='Enter'||event.key===' ')void commit();else move(event.key==='Home'?0:event.key==='End'?100:Math.max(0,Math.min(100,valueRef.current+(event.key==='ArrowRight'?10:-10))))}}}>
    <Glyph name={busy?'lakeActivity':enabled?'check':'lakePilot'} size={16}/>
   </button>
  </div>
  <span id={hint} className="visually-hidden">向右滑动解锁自动推进，向左滑动关闭。仅对新任务生效，变更仍按权限确认。键盘方向键或 Home、End 调整，到达端点后按 Enter 或空格确认。</span>
  {error&&<p role="alert" className="pilot-auto-error">{error}</p>}
 </div>;
}
