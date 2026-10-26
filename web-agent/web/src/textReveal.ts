type RevealFrames = {request:(callback:FrameRequestCallback)=>number;cancel:(id:number)=>void;now:()=>number};
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
export const TEXT_REVEAL_MAX_LAG_MS=80;
const MIN_GRAPHEMES_PER_SECOND=320;

// Presentation only: canonical content and completion state never wait for frames.
// Initial/restored text is immediate; only append updates of a live reply animate.
export class TextReveal {
 private source:string;
 private shown:string;
 private boundaries:number[]=[];
 private frame:number|null=null;
 private previousTime:number|null=null;
 private deadline=0;
 private credit=0;
 constructor(initial:string,private publish:(text:string)=>void,private frames:RevealFrames={request:cb=>window.requestAnimationFrame(cb),cancel:id=>window.cancelAnimationFrame(id),now:()=>performance.now()}){this.source=initial;this.shown=initial}
 update(text:string,animate:boolean){
  if(!animate||!text.startsWith(this.source)){this.flush(text);return}
  if(text===this.source)return;
  this.source=text;
  // Segment only the pending suffix, keeping all previously visible text stable.
  this.boundaries=Array.from(segmenter.segment(text.slice(this.shown.length)),s=>this.shown.length+s.index+s.segment.length);
  // Keep a fixed catch-up window while text is pending. Frequent packets must
  // not keep extending the deadline and leave the display behind the source.
  if(this.frame===null){
   this.previousTime=this.frames.now();
   this.deadline=this.previousTime+TEXT_REVEAL_MAX_LAG_MS;
   this.frame=this.frames.request(this.tick);
  }
 }
 flush(text=this.source){
  this.stop();this.source=text;
  if(this.shown!==text){this.shown=text;this.publish(text)}
 }
 stop(){if(this.frame!==null)this.frames.cancel(this.frame);this.frame=null;this.previousTime=null;this.credit=0}
 private tick=(time:number)=>{
  this.frame=null;
  if(time>=this.deadline){this.flush();return}
  const elapsed=this.previousTime===null?16.67:Math.max(0,time-this.previousTime);
  this.previousTime=time;
  const remaining=this.boundaries.length;
  const catchUpRate=remaining*1000/Math.max(8,this.deadline-time);
  this.credit+=Math.max(MIN_GRAPHEMES_PER_SECOND,catchUpRate)*Math.min(elapsed,64)/1000;
  // A frame with pending graphemes always paints, including 120/144Hz panels.
  const count=Math.min(remaining,Math.max(1,Math.floor(this.credit)));
  if(count>0){
   this.credit=Math.max(0,this.credit-count);
   const offset=this.boundaries[count-1]!;
   this.boundaries=this.boundaries.slice(count);
   this.shown=this.source.slice(0,offset);this.publish(this.shown);
  }
  if(this.shown!==this.source)this.frame=this.frames.request(this.tick);
  else {this.previousTime=null;this.credit=0}
 };
}
