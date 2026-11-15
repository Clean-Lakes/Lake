import assert from 'node:assert/strict';
import test from 'node:test';
import {lakeAvatarCatalog} from '../src/lakeAvatarCatalog';
import {lakeAvatarArtwork} from '../src/lakeAvatarArtwork';
import {lakeAvatarThinking,thinkingPoseOffsets} from '../src/lakeAvatarThinking';

test('every selectable Lake species has a readable thinking phrase and grounded choreography',()=>{
 assert.deepEqual(Object.keys(lakeAvatarThinking).sort(),lakeAvatarCatalog.map(row=>row.id).sort());
 const labels=new Set<string>();
 for(const {id} of lakeAvatarCatalog){
  const definition=lakeAvatarThinking[id];labels.add(definition.label);
  assert.match(definition.label,/^正在.+中$/,id);
  assert.doesNotMatch(definition.label,/完成|验收|成功|失败|执行|等待|确认|重连|%/,id);
  assert.ok(definition.foot>=40&&definition.foot<=64,`${id} must anchor within its artwork`);
  assert.ok(definition.durationMs>=3000&&definition.durationMs<=6500,`${id} must use a calm thinking loop`);
  const parts=new Set<string>(lakeAvatarArtwork[id].parts.map(part=>part.name));
  parts.add('body');if(id==='otter')parts.add('other');if(id==='fox')parts.add('ear');
  assert.ok(Object.keys(definition.poses).length>0,`${id} needs visible character motion`);
  for(const [channel,poses] of Object.entries(definition.poses)){
   assert.ok(parts.has(channel),`${id}.${channel} must target painted anatomy`);
   assert.equal(poses.length,thinkingPoseOffsets.length,`${id}.${channel}`);
   assert.equal(poses.at(-1),poses[0],`${id}.${channel} must return without a loop jump`);
   assert.equal(poses.at(-2),poses.at(-1),`${id}.${channel} must rest at the end`);
   assert.ok(new Set(poses).size>1,`${id}.${channel} must move`);
   for(const pose of poses)assert.match(pose,/^(?:t-?(?:\d+(?:\.\d+)?|\.\d+),-?(?:\d+(?:\.\d+)?|\.\d+))?(?:r-?(?:\d+(?:\.\d+)?|\.\d+))?(?:s(?:\d+(?:\.\d+)?|\.\d+),(?:\d+(?:\.\d+)?|\.\d+))?$/,`${id}.${channel}: ${pose}`);
  }
 }
 assert.equal(labels.size,lakeAvatarCatalog.length,'species do not fall back to a shared thinking label');
 assert.equal(thinkingPoseOffsets[0],0);assert.equal(thinkingPoseOffsets.at(-1),1);
 assert.ok(thinkingPoseOffsets.every((value,index)=>index===0||value>thinkingPoseOffsets[index-1]));
});

test('the eight approved thinking concepts keep their labels and border contact points',()=>{
 const approved={
  otter:['正在搓爪琢磨中',4200,51,'left'],
  beaver:['正在搭建思路中',4600,50,'left'],
  owl:['正在歪头推敲中',4800,56,'right'],
  fox:['正在盘算办法中',4600,51,'right'],
  turtle:['正在慢慢推演中',5600,46,'left'],
  bee:['正在采集灵感中',3800,55,'right'],
  woodpecker:['正在逐点琢磨中',3800,56,'right'],
  pufferfish:['正在鼓着脑袋想中',4800,55,'right'],
 } as const;
 for(const id of Object.keys(approved) as (keyof typeof approved)[]){
  const {label,durationMs,foot,side}=lakeAvatarThinking[id];
  assert.deepEqual([label,durationMs,foot,side],approved[id],id);
 }
 assert.deepEqual(lakeAvatarThinking.otter.poses.fore,['t0,0r-22','t1,-1r-28','t-1,0r-18','t1,-1r-28','t0,0r-22','t0,0r-22','t0,0r-22','t0,0r-22']);
 assert.ok(lakeAvatarThinking.otter.poses.other,'rubbing uses both paws');
 assert.equal(lakeAvatarThinking.owl.poses.body,undefined,'the owl keeps its feet planted while looking around');
 assert.equal(lakeAvatarThinking.turtle.poses.head?.[3],'t6,-1r-7');
 assert.equal(lakeAvatarThinking.pufferfish.poses.shell?.[3],'s1.07,1.07');
 assert.equal(lakeAvatarThinking.fox.poses.ear?.[1],'t0,-1.5');
});
