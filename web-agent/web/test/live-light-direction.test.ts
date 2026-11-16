import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {LiveTextMotionLabel,LiveTextMotionText} from '../src/liveTextMotion';

function glyphs(text:string,options:{glow?:boolean;leading?:boolean;active?:boolean}={glow:true}){
 const html=renderToStaticMarkup(createElement(LiveTextMotionLabel,{children:text,active:true,...options}));
 return {html,items:[...html.matchAll(/data-text-offset="(\d+)" style="--live-text-phase:([\d.-]+)ms">([^<]*)<\/span>/g)].map(match=>({offset:Number(match[1]),delay:Number(match[2]),text:match[3]}))};
}

test('name and status light peaks advance left to right through full graphemes, independent of UTF-16 offsets',()=>{
 for(const text of ['猫头鹰动画验收专员','正在歪头推敲中','A 👩🏽‍💻 e\u0301 🇨🇳 中']){
  const {items}=glyphs(text);
  assert.equal(items.map(item=>item.text).join(''),text.replaceAll(' ',''));
  assert.equal(items[0]!.delay+items.at(-1)!.delay,0,'the wave midpoint stays on the shared header peak');
  for(let i=1;i<items.length;i++)assert.equal(items[i]!.delay-items[i-1]!.delay,73,'later glyphs reach the peak later');
 }
 assert.ok(glyphs('A 👩🏽‍💻 e\u0301 🇨🇳 中').items.some(item=>item.text==='👩🏽‍💻'));
});

test('long head and tail light windows never wrap their peaks into another 3.4-second cycle',()=>{
 const text='👩🏽‍💻服务器资源核对e\u0301'.repeat(20);
 for(const leading of [true,false]){
  const {items,html}=glyphs(text,{glow:true,leading});
  assert.equal(items.length,24);
  const peaks=items.map(item=>1700+item.delay);
  assert.equal(peaks[0],860.5);assert.equal(peaks.at(-1),2539.5);
  assert.ok(peaks.every((peak,i)=>peak-204>0&&peak+204<3400&&(!i||peak>peaks[i-1]!)),'full glow envelopes stay in one cycle');
  assert.ok(leading?items[0]!.offset===0:items[0]!.offset>280,'long tail offsets do not create modulo reversals');
  assert.equal(html.replace(/<[^>]*>/g,''),text,'one complete selectable copy remains');
 }
});

test('single glyph and static labels retain deterministic light phases without extra animation nodes',()=>{
 assert.deepEqual(glyphs('👩🏽‍💻').items.map(item=>item.delay),[0]);
 assert.equal(glyphs(' \t\n').items.length,0);
 const text='正在搓爪琢磨中';
 assert.equal(glyphs(text).html.replaceAll('="active"','="still"'),glyphs(text,{glow:true,active:false}).html);
});

test('ordinary prose and non-glowing labels keep their original phases and source offsets',()=>{
 const text='公开文字👩🏽‍💻继续追加',plain=glyphs(text,{glow:false});
 assert.ok(plain.items.every(item=>item.delay===-(item.offset*73%2800)));
 const before=renderToStaticMarkup(createElement(LiveTextMotionText,{text,start:2}));
 const explicit=renderToStaticMarkup(createElement(LiveTextMotionText,{text,start:2,glow:false}));
 assert.equal(before,explicit);
 assert.deepEqual(glyphs(text).items.map(item=>item.offset),plain.items.map(item=>item.offset),'light direction does not change DOM identities');
});
