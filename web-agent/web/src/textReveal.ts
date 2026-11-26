type RevealFrames = {request:(callback:FrameRequestCallback)=>number;cancel:(id:number)=>void;now:()=>number};
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
export const TEXT_REVEAL_MAX_LAG_MS=180;
export const TEXT_REVEAL_BURST_MAX_LAG_MS=420;
const BUFFER_WINDOW_MS=130;
const MIN_GRAPHEMES_PER_SECOND=32;
const PACED_GRAPHEMES_PER_SECOND=18;
const BURST_MS_PER_GRAPHEME=4;
const MAX_FRAME_PLAYBACK_MS=34;
type TextPacket = {end:number;due:number;receivedAt:number};

export function firstGrapheme(text:string):string {
 return segmenter.segment(text)[Symbol.iterator]().next().value?.segment??'';
}

export function lastGrapheme(text:string) {
 return segmenter.segment(text).containing(text.length-1);
}

// Presentation only: canonical content and completion state never wait for frames.
// Initial/restored text is immediate; only append updates of a live reply animate.
export class TextReveal {
 private source:string;
 private shown:string;
 private boundaries:number[]=[];
 private packets:TextPacket[]=[];
 private frame:number|null=null;
 private previousTime=0;
 private lastPacketAt=-Infinity;
 private credit=0;
 constructor(initial:string,private publish:(text:string)=>void,private frames:RevealFrames={request:cb=>window.requestAnimationFrame(cb),cancel:id=>window.cancelAnimationFrame(id),now:()=>performance.now()},private paceBursts=false){this.source=initial;this.shown=initial}
 update(text:string,animate:boolean){
  if(!animate||!text.startsWith(this.source)){this.flush(text);return}
  if(text===this.source)return;
  const previousLength=this.source.length;
  this.source=text;
  // Segment only the pending suffix, keeping all previously visible text stable.
  this.boundaries=Array.from(segmenter.segment(text.slice(this.shown.length)),s=>this.shown.length+s.index+s.segment.length);
  const receivedAt=this.frames.now();
  const lag=this.paceBursts?Math.min(TEXT_REVEAL_BURST_MAX_LAG_MS,Math.max(TEXT_REVEAL_MAX_LAG_MS,
   this.boundaries.filter(boundary=>boundary>previousLength).length*BURST_MS_PER_GRAPHEME)):TEXT_REVEAL_MAX_LAG_MS;
  // A short packet behind a burst shares its deadline instead of speeding up
  // the whole earlier batch. Reserve the same time window for existing text.
  const due=Math.max(receivedAt+lag,this.packets.at(-1)?.due??0);
  this.packets.push({end:text.length,due,receivedAt});
  if(this.frame===null){
   if(!this.paceBursts||receivedAt-this.lastPacketAt>=TEXT_REVEAL_MAX_LAG_MS)this.credit=1;
   this.previousTime=receivedAt;
   this.frame=this.frames.request(this.tick);
  }
  this.lastPacketAt=receivedAt;
 }
 flush(text=this.source){
  this.stop();this.source=text;
  if(this.shown!==text){this.shown=text;this.publish(text)}
 }
 stop(){
  if(this.frame!==null)this.frames.cancel(this.frame);
  this.frame=null;
  this.packets=[];this.boundaries=[];this.credit=0;this.lastPacketAt=-Infinity;
 }
 private tick=(time:number)=>{
  this.frame=null;
  const now=Math.max(time,this.previousTime);
  const elapsed=Math.min(now-this.previousTime,MAX_FRAME_PLAYBACK_MS);
  const missedUntil=now-elapsed;
  // A missed display frame cannot paint its share of the text. Let the next
  // visible frames catch up without flushing the entire packet at once.
  if(missedUntil>this.previousTime){
   for(const packet of this.packets)packet.due+=Math.max(0,missedUntil-Math.max(this.previousTime,packet.receivedAt));
  }
  const remaining=this.boundaries.length;
  // Keep a little received text in reserve to bridge uneven packet arrivals.
  // Each packet also owns its deadline. Finishing an old packet never flushes
  // younger text along with it or moves its deadline on a later arrival.
  let rate=this.paceBursts?PACED_GRAPHEMES_PER_SECOND:Math.max(MIN_GRAPHEMES_PER_SECOND,remaining*1000/BUFFER_WINDOW_MS);
  let boundary=0,overdue=0;
  for(const packet of this.packets){
   while(this.boundaries[boundary]!<packet.end)boundary++;
   const throughPacket=boundary+1;
   if(packet.due<=now){overdue=throughPacket;continue;}
   rate=Math.max(rate,throughPacket*1000/Math.max(1,packet.due-this.previousTime));
   if(!this.paceBursts)break;
  }
  this.previousTime=now;
  this.credit+=rate*elapsed/1000;
  const count=Math.min(remaining,Math.max(overdue,Math.floor(this.credit)));
  if(count>0){
   this.credit=Math.max(0,this.credit-count);
   const offset=this.boundaries[count-1]!;
   this.boundaries=this.boundaries.slice(count);
   while(this.packets[0]&&this.packets[0].end<=offset)this.packets.shift();
   this.shown=this.source.slice(0,offset);this.publish(this.shown);
  }
  if(this.boundaries.length)this.frame=this.frames.request(this.tick);
  else this.credit=Math.min(this.credit,1);
 };
}
