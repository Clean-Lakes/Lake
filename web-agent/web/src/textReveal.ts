type RevealFrames = {request:(callback:FrameRequestCallback)=>number;cancel:(id:number)=>void;now:()=>number};
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});

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
  this.deadline=this.frames.now()+200;
  if(this.frame===null)this.frame=this.frames.request(this.tick);
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
  this.credit+=Math.max(80,remaining*10)*Math.min(elapsed,64)/1000;
  const count=Math.min(remaining,Math.floor(this.credit));
  if(count>0){
   this.credit-=count;
   const offset=this.boundaries[count-1]!;
   this.boundaries=this.boundaries.slice(count);
   this.shown=this.source.slice(0,offset);this.publish(this.shown);
  }
  if(this.shown!==this.source)this.frame=this.frames.request(this.tick);
  else {this.previousTime=null;this.credit=0}
 };
}
