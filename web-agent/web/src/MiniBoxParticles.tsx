import {useEffect,useRef} from 'react';

// Sparse, subtle particles follow only this viewport's inner rounded perimeter.
// There is no full-page overlay and no animation while hidden or motion-reduced.
export function MiniBoxParticles(){
  const ref=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    const canvas=ref.current;if(!canvas)return;
    const context=canvas.getContext('2d');if(!context)return;
    const motion=matchMedia('(prefers-reduced-motion: reduce)');
    let frame=0,width=0,height=0,blue='',disposed=false;
    const paint=(time:number)=>{
      frame=0;if(disposed||document.hidden)return;
      context.clearRect(0,0,width,height);
      const r=Math.min(12,width/4,height/4),w=Math.max(0,width-8),h=Math.max(0,height-8);
      const straightX=Math.max(0,w-2*r),straightY=Math.max(0,h-2*r),arc=Math.PI*r/2;
      const lengths=[straightX,arc,straightY,arc,straightX,arc,straightY,arc];
      const perimeter=lengths.reduce((sum,value)=>sum+value,0);
      if(perimeter<=0)return;
      const seconds=motion.matches?0:time/1000;
      const count=Math.min(160,Math.max(60,Math.round(perimeter/11)));
      for(let i=0;i<count;i++){
        const seed=(i*.61803398875)%1,phase=(i/count+seconds*.034)%1;
        let distance=phase*perimeter,segment=0;
        while(segment<7&&distance>lengths[segment]!){distance-=lengths[segment]!;segment++;}
        const u=lengths[segment]?distance/lengths[segment]!:0;
        let x=0,y=0,nx=0,ny=0;
        if(segment===0){x=r+u*straightX;ny=-1;}
        else if(segment===2){x=w;y=r+u*straightY;nx=1;}
        else if(segment===4){x=w-r-u*straightX;y=h;ny=1;}
        else if(segment===6){y=h-r-u*straightY;nx=-1;}
        else {
          const corner=(segment-1)/2,angle=-Math.PI/2+corner*Math.PI/2+u*Math.PI/2;
          nx=Math.cos(angle);ny=Math.sin(angle);
          x=(corner===0||corner===1?w-r:r)+r*nx;
          y=(corner===0||corner===3?r:h-r)+r*ny;
        }
        const drift=Math.sin(seconds*.7+i*2.4)*(.4+seed*.5);
        const wave=.07+.22*Math.pow(Math.max(0,Math.sin(phase*Math.PI*4-seconds*.4)),3);
        const size=.3+seed*.35;
        const px=4+x+nx*drift,py=4+y+ny*drift;
        context.fillStyle=blue;context.globalAlpha=wave;
        context.beginPath();context.arc(px,py,size,0,Math.PI*2);context.fill();
      }
      context.globalAlpha=1;
      if(!motion.matches)frame=requestAnimationFrame(paint);
    };
    const restart=()=>{cancelAnimationFrame(frame);frame=0;if(!document.hidden&&!disposed)frame=requestAnimationFrame(paint);};
    const resize=()=>{
      width=canvas.clientWidth;height=canvas.clientHeight;
      const dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
      context.setTransform(dpr,0,0,dpr,0,0);
      blue=getComputedStyle(document.documentElement).getPropertyValue('--reasoning-accent').trim()||'#3683fa';restart();
    };
    const observer=new ResizeObserver(resize);observer.observe(canvas);
    const theme=new MutationObserver(resize);theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    document.addEventListener('visibilitychange',restart);motion.addEventListener('change',restart);resize();
    return()=>{disposed=true;cancelAnimationFrame(frame);observer.disconnect();theme.disconnect();document.removeEventListener('visibilitychange',restart);motion.removeEventListener('change',restart);};
  },[]);
  return <canvas className="mini-box-particles" ref={ref} aria-hidden="true"/>;
}
