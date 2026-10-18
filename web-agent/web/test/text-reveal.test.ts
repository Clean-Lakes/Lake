import test from 'node:test';
import assert from 'node:assert/strict';
import {TextReveal} from '../src/textReveal';
function fixture(initial=''){
 let now=0,id=0;const pending=new Map<number,FrameRequestCallback>(),values:string[]=[];
 const reveal=new TextReveal(initial,text=>values.push(text),{request:cb=>{pending.set(++id,cb);return id},cancel:n=>{pending.delete(n)},now:()=>now});
 const frame=(ms=16.67)=>{now+=ms;const callbacks=[...pending.values()];pending.clear();callbacks.forEach(cb=>cb(now))};
 return {reveal,values,pending,frame};
}
test('live append is monotonic, coalesced to one frame and catches up within 200 ms',()=>{
 const f=fixture('已收到。');const target='已收到。'+ '新的检查结果，正在按接收内容逐步呈现。'.repeat(20);
 f.reveal.update(target,true);f.reveal.update(target+'尾部',true);
 assert.equal(f.pending.size,1);assert.equal(f.values.length,0);
 f.frame();assert.ok(f.values[0]!.length<target.length);assert.ok(f.values[0]!.startsWith('已收到。'));
 for(let i=0;i<12;i++)f.frame();
 assert.equal(f.values.at(-1),target+'尾部');assert.equal(f.pending.size,0);
 for(let i=1;i<f.values.length;i++)assert.ok(f.values[i]!.startsWith(f.values[i-1]!));
});
test('completion, stop, errors/replacement, hidden and reduced-motion callers flush immediately',()=>{
 for(const final of ['最终结果。','已停止前的实际内容。']){
  const f=fixture();f.reveal.update('中间内容正在生成。'.repeat(10),true);f.frame();
  f.reveal.update(final,false);assert.equal(f.values.at(-1),final);assert.equal(f.pending.size,0);f.frame();assert.equal(f.values.at(-1),final);
 }
 const f=fixture('旧内容');f.reveal.update('旧内容后续内容'.repeat(8),true);f.frame();f.reveal.update('替换后的正确内容',true);
 assert.equal(f.values.at(-1),'替换后的正确内容');assert.equal(f.pending.size,0);
});
test('Chinese, emoji, combining accents and ZWJ clusters are never split during a queued append',()=>{
 const f=fixture();const source='中文👩🏽‍💻e\u0301🇨🇳👍🏽结束'.repeat(8);
 const boundaries=new Set(Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(source),s=>s.index+s.segment.length));
 f.reveal.update(source,true);for(let i=0;i<14;i++)f.frame();
 assert.equal(f.values.at(-1),source);for(const value of f.values)assert.ok(boundaries.has(value.length));
});
test('history has no animation, unchanged snapshots do not restart frames and disposal cancels pending work',()=>{
 const f=fixture('完整历史\n\n| 项目 | 状态 |');f.reveal.update('完整历史\n\n| 项目 | 状态 |',true);
 assert.equal(f.pending.size,0);assert.equal(f.values.length,0);
 f.reveal.update('完整历史\n\n| 项目 | 状态 |\n| CPU | 正常 |',true);f.frame();const count=f.values.length;
 f.reveal.stop();assert.equal(f.pending.size,0);f.frame();assert.equal(f.values.length,count);
});
test('new packets during streaming retarget the pending suffix without losing or duplicating text',()=>{
 const f=fixture();let source='';
 for(let i=0;i<20;i++){source+='新的结果'+i+'。';f.reveal.update(source,true);f.frame(25)}
 for(let i=0;i<10;i++)f.frame(25);
 assert.equal(f.values.at(-1),source);assert.equal(f.pending.size,0);
});
test('presentation follows display frames without a fixed 30fps ceiling',()=>{
 const f=fixture();f.reveal.update('连续内容'.repeat(100),true);
 for(let i=0;i<12;i++)f.frame(8.34);
 assert.ok(f.values.length>6,'high refresh displays must not be capped at one update per 32ms');
 assert.equal(f.pending.size,1);f.reveal.flush();assert.equal(f.pending.size,0);
});
