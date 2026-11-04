import assert from 'node:assert/strict';
import test from 'node:test';
import {lakeAvatarCatalog} from '../src/lakeAvatarCatalog';
import {lakeAvatarArtwork} from '../src/lakeAvatarArtwork';
import {avatarMotionStyle,lakeAvatarMotions} from '../src/lakeAvatarMotion';

test('all 100 species have distinct anatomy independent of colour, labels and motion',()=>{
 const ids=lakeAvatarCatalog.map(avatar=>avatar.id);
 assert.deepEqual(Object.keys(lakeAvatarArtwork),ids,'existing species and order remain authoritative');
 const shapes=new Set(ids.map(id=>JSON.stringify({fit:lakeAvatarArtwork[id].fit,parts:lakeAvatarArtwork[id].parts.map(part=>({paths:part.shapes.map(shape=>shape.d),eyes:part.eyes}))})));
 assert.equal(shapes.size,100);
 for(const id of ids){assert.ok(lakeAvatarArtwork[id].parts.length>=2);assert.ok(lakeAvatarArtwork[id].parts.every(part=>part.shapes.length));}
});

test('every painted path has complete SVG commands, including repeated curve segments',()=>{
 const sizes:Record<string,number>={m:2,l:2,h:1,v:1,c:6,s:4,q:4,t:2,a:7,z:0};
 for(const [id,art] of Object.entries(lakeAvatarArtwork))for(const part of art.parts)for(const shape of part.shapes){
  const tokens=shape.d.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)!;
  let command='',args:number[]=[];
  const check=()=>{if(!command)return;const size=sizes[command.toLowerCase()];assert.ok(size!==undefined,`${id}: unknown command ${command}`);assert.ok(size===0?args.length===0:args.length>0&&args.length%size===0,`${id}/${part.name}: incomplete ${command} segment`);assert.ok(args.every(Number.isFinite));};
  for(const token of [...tokens,'END']){if(token==='END'||/^[A-Za-z]$/.test(token)){check();command=token;args=[];}else args.push(Number(token));}
 }
});

test('100 working and 100 greeting trajectories differ on visible anatomical parts without using timing or colour',()=>{
 assert.equal(Object.keys(lakeAvatarMotions).length,100);
 for(const mode of ['w','g']){
  const trajectories=new Set(lakeAvatarCatalog.map(({id})=>{
   const visible=new Set(['body',...lakeAvatarArtwork[id].parts.map(part=>part.name)]);
   return JSON.stringify(Object.entries(avatarMotionStyle(id)).filter(([key])=>key.startsWith(`--av-${mode}-`)&&visible.has(key.split('-').at(-2)!)));
  }));
  assert.equal(trajectories.size,100,`${mode}: different durations or phases do not count as different gestures`);
 }
});
