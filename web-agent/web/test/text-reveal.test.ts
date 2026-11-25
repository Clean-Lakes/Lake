import test from 'node:test';
import assert from 'node:assert/strict';
import {TextReveal,TEXT_REVEAL_MAX_LAG_MS} from '../src/textReveal';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AssistantMarkdown} from '../src/AssistantMarkdown';
import {remarkRevealText} from '../src/markdownReveal';
import {SpecialistReplyWaiting} from '../src/SpecialistReplyCursor';

test('a specialist cursor keeps the final grapheme and leaves inline links intact',()=>{
 const render=(children:string)=>renderToStaticMarkup(createElement(AssistantMarkdown,{children,cursorAvatar:'rabbit'}));
 const formatted=render('正在核对 **记录👩🏽‍💻**');
 assert.match(formatted,/class="specialist-reply-cursor-tail">👩🏽‍💻<span class="specialist-reply-cursor"/);
 const link=render('正在核对 [记录](https://example.com)');
 assert.match(link,/<a[^>]*>记录<\/a><span class="specialist-reply-cursor"/);
});

test('waiting only marks the existing animal and keeps one copy of the prose',()=>{
 const text='甲乙丙👩🏽‍💻一二三四五六七';
 const render=(value:boolean)=>renderToStaticMarkup(createElement(SpecialistReplyWaiting.Provider,{value},
  createElement(AssistantMarkdown,{children:text,cursorAvatar:'rabbit'})));
 const waiting=render(true),resumed=render(false);
 assert.match(waiting,/甲乙丙👩🏽‍💻一二三四五六<span class="specialist-reply-cursor-tail">七/);
 assert.match(waiting,/class="specialist-reply-cursor" data-cursor-avatar="rabbit" data-waiting="true"/);
 assert.match(waiting,/class="specialist-cursor-rabbit"/);
 assert.equal(waiting.replace(/<[^>]*>/g,''),text);
 assert.equal(waiting.replaceAll(' data-waiting="true"',''),resumed);
});
function fixture(initial=''){
 let now=0,id=0;const pending=new Map<number,FrameRequestCallback>(),values:string[]=[];
 const reveal=new TextReveal(initial,text=>values.push(text),{request:cb=>{pending.set(++id,cb);return id},cancel:n=>{pending.delete(n)},now:()=>now});
 const frame=(ms=16.67)=>{now+=ms;const callbacks=[...pending.values()];pending.clear();callbacks.forEach(cb=>cb(now))};
 return {reveal,values,pending,frame,time:()=>now};
}
test('live append is monotonic, coalesced to one frame and catches up within its deadline',()=>{
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
 for(let i=0;i<6;i++)f.frame(8.34);
 assert.equal(f.values.length,6,'every display frame paints pending text');
 assert.equal(f.pending.size,1);f.reveal.flush();assert.equal(f.pending.size,0);
});

test('small bursts paint on every 120/144Hz display frame and use a short catch-up window',()=>{
 for(const ms of [1000/120,1000/144]){
  const f=fixture();f.reveal.update('正文'.repeat(40),true);
  for(let i=0;i<5;i++)f.frame(ms);
  assert.equal(f.values.length,5);
  while(f.pending.size)f.frame(ms);
  assert.equal(f.values.at(-1),'正文'.repeat(40));
 }
 assert.equal(TEXT_REVEAL_MAX_LAG_MS,180);
});
test('each packet meets its own deadline while newly arrived text keeps its pacing',()=>{
 const f=fixture(),first='先前收到'.repeat(20),latest=first+'后来收到'.repeat(20);
 f.reveal.update(first,true);
 for(let i=0;i<10;i++)f.frame(16);
 f.reveal.update(latest,true);
 f.frame(TEXT_REVEAL_MAX_LAG_MS-f.time());
 assert.ok(f.values.at(-1)!.startsWith(first));
 assert.ok(f.values.at(-1)!.length<latest.length);
 while(f.pending.size)f.frame();
 assert.equal(f.values.at(-1),latest);
});

test('a delayed display frame continues the reveal without dumping the received suffix',()=>{
 const f=fixture('核');
 const first='核对服务状态。'.repeat(18),next=first+'已记录实际结果。'.repeat(8);
 f.reveal.update(first,true);
 f.frame(240);
 assert.ok(f.values[0]!.length>1&&f.values[0]!.length<first.length);
 f.reveal.update(next,true);
 for(let i=0;i<12;i++)f.frame();
 assert.equal(f.values.at(-1),next);
});

test('a fresh short update after the last packet starts on the next high-refresh frame',()=>{
 const f=fixture();
 f.reveal.update('核',true);f.frame(1000/144);
 f.frame(55);
 f.reveal.update('核对',true);f.frame(1000/144);
 assert.deepEqual(f.values,['核','核对']);
});

test('coalesced token bursts paint evenly across the gap and start on the first frame',()=>{
 const f=fixture(),paintTimes:number[]=[];
 let source='';
 for(let index=0;index<110;index++){
  if(index<96&&index%6===0){
   for(const text of ['检查','就','绪。']){source+=text;f.reveal.update(source,true);}
  }
  const previous=f.values.length;
  f.frame(16);
  if(f.values.length>previous)paintTimes.push(f.time());
 }
 assert.equal(paintTimes[0],16);
 assert.equal(f.values.at(-1),source);
 assert.ok(paintTimes.slice(1).every((time,index)=>time-paintTimes[index]!<=64));
 let previous='';
 for(const value of f.values){
  assert.ok(value.length-previous.length<=2);
  previous=value;
 }
});

test('the display frame only owns the trailing literal text after a parsed reference',()=>{
 const source='[历史链接](#history)\n\n**结论** 最后是中文 👩🏽‍💻';
 const value=' 最后是中文 👩🏽‍💻';
 const link={type:'link',children:[{type:'text',value:'历史链接'}]};
 const emphasis={type:'strong',children:[{type:'text',value:'结论'}]};
 const tree={type:'root',children:[
  {type:'paragraph',children:[link]},
  {type:'paragraph',position:{end:{offset:source.length}},children:[emphasis,{type:'text',value}]},
 ]};
 const before=structuredClone(tree);
 remarkRevealText(source.length-value.length)()(tree,{value:source});
 assert.deepEqual(tree.children[0],before.children[0]);
 assert.deepEqual(tree.children[1]?.children[0],emphasis);
 assert.deepEqual(tree.children[1]?.children[1],{
  type:'lakeRevealText',data:{hName:'lake-reveal-text',hProperties:{'data-reveal-start':source.length-value.length}},
  children:[{type:'text',value}],
 });
});

test('a new paragraph does not expose the pending text left in the previous one',()=>{
 const stable='已绘制的正文。',first='上一段未显示完。',last='新段落。';
 const source=[stable,first,last].join('\n\n');
 const paragraph=(value:string,end:number)=>({type:'paragraph',position:{end:{offset:end}},children:[{type:'text',value}]});
 const history=paragraph(stable,stable.length);
 const tree={type:'root',children:[history,paragraph(first,stable.length+2+first.length),paragraph(last,source.length)]};
 const original=structuredClone(history);
 remarkRevealText(stable.length+4)()(tree,{value:source});
 assert.deepEqual(history,original);
 assert.equal(tree.children[1]!.children[0]!.type,'lakeRevealText');
 assert.equal(tree.children[2]!.children[0]!.type,'lakeRevealText');
});

test('streamed Markdown preserves the same markup for the complete reply',()=>{
 const render=(children:string,reveal?:boolean)=>renderToStaticMarkup(createElement(AssistantMarkdown,{children,reveal}));
 for(const source of [
  '**结论** 已检查 👩🏽‍💻。',
  '| 服务 | 状态 |\n| --- | --- |\n| 测试 | 正常 |\n\n[证据](#record) 已记录。',
  '> 第一行\n> 尾部 *有强调*\n\n- 列表\n  - 最后是中文',
  '```text\n&lt;literal&gt;\n```\n\n正文结束 &amp; 已保存。',
 ]){
  assert.equal(render(source,false),render(source));
  assert.equal(render(source,true),render(source));
 }
});

test('a new reply mounts with its first complete grapheme and a restored reply mounts fully',()=>{
 const source='👩🏽‍💻开始核对。';
 const initial=renderToStaticMarkup(createElement(AssistantMarkdown,{children:source,reveal:true,animateInitial:true}));
 assert.equal(initial,'<div class="ai-markdown assistant-prose"><p>👩🏽‍💻</p></div>');
 const restored=renderToStaticMarkup(createElement(AssistantMarkdown,{children:source,reveal:true,animateInitial:false}));
 assert.equal(restored,'<div class="ai-markdown assistant-prose"><p>'+source+'</p></div>');
 const alreadyCompleted=renderToStaticMarkup(createElement(AssistantMarkdown,{children:source,reveal:false,finishPending:true,animateInitial:true}));
 assert.equal(alreadyCompleted,initial,'the current reply can first arrive in a completed snapshot');
 const restoredCompletion=renderToStaticMarkup(createElement(AssistantMarkdown,{children:source,reveal:false,finishPending:true}));
 assert.equal(restoredCompletion,restored,'completed history never starts a new reveal');
});
