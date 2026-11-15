import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AnimalThinkingBubble} from '../src/AnimalThinkingBubble';
import {SpecialistAvatarProvider} from '../src/SuperRoleAvatar';
import {LakeAvatarFigure} from '../src/LakeAvatarFigure';
import {createAnimalThinkingMotion} from '../src/animalThinkingMotion';
import {lakeAvatarThinking} from '../src/lakeAvatarThinking';
import {superWorkerAppearance} from '../src/superAgentPresentation';
import type {LakeAvatarName} from '../src/lakeAvatarCatalog';

const channel={id:'channel',projectId:'project',roleId:'stable-role',roleName:'数据专员',sessionId:'channel-session',revision:1,createdAt:'',avatarId:'turtle' as const};
test('thinking text and the 28px character use the same explicit, project, or stable avatar',()=>{
 const render=(avatarId?:LakeAvatarName,channels=[channel],name='数据专员')=>renderToStaticMarkup(createElement(SpecialistAvatarProvider,{channels,children:createElement(AnimalThinkingBubble,{name,roleId:channel.roleId,avatarId})}));
 const project=render();
 assert.match(project,/data-animal="turtle"/);
 assert.match(project,/data-avatar="turtle" width="28" height="28"/);
 assert.match(project,/正在慢慢推演中/);
 assert.match(project,/role="status" aria-live="polite" aria-atomic="true"/);
 assert.doesNotMatch(project,/loading-waves|status-text-active/);
 const explicit=render('pufferfish');
 assert.match(explicit,/data-avatar="pufferfish" width="28" height="28"/);
 assert.match(explicit,/正在鼓着脑袋想中/);
 assert.doesNotMatch(explicit,/正在慢慢推演中/);
 assert.equal(render(undefined,[channel],'改名后的专员'),project,'a role rename cannot change its character or thinking label');
 const fallback=superWorkerAppearance({roleId:channel.roleId,roleName:channel.roleName}).icon;
 const switchedProject=render(undefined,[]);
 assert.match(switchedProject,new RegExp(`data-avatar="${fallback}"`));
 assert.ok(switchedProject.includes(lakeAvatarThinking[fallback].label));
});

test('thinking articulation is opt-in and ordinary Lake figures retain their anatomy',()=>{
 const figure=(role:LakeAvatarName,thinking=false)=>renderToStaticMarkup(createElement(LakeAvatarFigure,{role,size:28,className:'test-figure',thinking}));
 assert.doesNotMatch(figure('otter'),/avatar-other/);
 assert.match(figure('otter',true),/avatar-other/);
 assert.doesNotMatch(figure('fox'),/avatar-ear/);
 assert.match(figure('fox',true),/avatar-ear/);
 assert.match(figure('owl'),/avatar-head" style="transform-box:view-box;transform-origin:39px 29px/);
 assert.match(figure('owl',true),/avatar-head" style="transform-box:view-box;transform-origin:32px 29px/);
 const still=renderToStaticMarkup(createElement(AnimalThinkingBubble,{avatarId:'otter',active:false}));
 assert.match(still,/data-motion="still"/);
 assert.match(still,/正在搓爪琢磨中/);
 assert.match(still,/--thinking-character-ground:22.3125px/);
});

function motionFixture(){
 const recordings:{frames:Keyframe[];options:KeyframeAnimationOptions;animation:FakeAnimation}[]=[];
 class FakeAnimation{
  currentTime:number|null=0;
  playState='running';
  cancels=0;
  plays=0;
  pauses=0;
  pause(){this.pauses++;this.playState='paused';}
  play(){this.plays++;this.playState='running';}
  cancel(){this.cancels++;this.playState='idle';this.currentTime=null;}
 }
 const node=()=>({style:{transform:''},animate(frames:Keyframe[],options:KeyframeAnimationOptions){const animation=new FakeAnimation();recordings.push({frames,options,animation});return animation;}});
 const nodes=new Map(['body','head','fore','other','tail','wing','shell','ear'].map(channel=>[`.avatar-${channel}`,node()]));
 const eyes=[node(),node()];
 const root={querySelector(selector:string){return nodes.get(selector)??null;},querySelectorAll(selector:string){return selector==='.avatar-eye'?eyes:[];}} as unknown as ParentNode;
 return {root,nodes,eyes,recordings};
}

test('visibility and inactive pauses preserve phase without recreating character animation',()=>{
 const fixture=motionFixture(),motion=createAnimalThinkingMotion(fixture.root,'otter',{phase:-1700});
 const initial=fixture.recordings.length;
 assert.ok(initial>2,'articulated character and eyes animate');
 assert.ok(fixture.recordings.every(({animation})=>animation.currentTime===1700));
 fixture.recordings.forEach(({animation})=>{animation.currentTime=1900;});
 motion.setPaused(true);
 assert.ok(fixture.recordings.every(({animation})=>animation.playState==='paused'));
 motion.setPaused(true);
 assert.ok(fixture.recordings.every(({animation})=>animation.pauses===1),'repeated hidden notifications do not restart motion');
 motion.setPaused(false);
 assert.equal(fixture.recordings.length,initial);
 assert.ok(fixture.recordings.every(({animation})=>animation.playState==='running'&&animation.currentTime===1900));
 motion.dispose();
 assert.ok(fixture.recordings.every(({animation})=>animation.cancels===1));
 assert.ok([...fixture.nodes.values(),...fixture.eyes].every(node=>node.style.transform===''));
 motion.setPaused(false);
 motion.setReducedMotion(false);
 assert.equal(fixture.recordings.length,initial,'a removed character cannot restart');
});

test('reduced motion cancels all tracks and retains a resting pose, including when it changes live',()=>{
 const fixture=motionFixture(),motion=createAnimalThinkingMotion(fixture.root,'otter',{reducedMotion:true,paused:true});
 assert.equal(fixture.recordings.length,0);
 assert.notEqual(fixture.nodes.get('.avatar-fore')!.style.transform,'','the static character keeps its resting paws');
 motion.setReducedMotion(false);
 const tracks=fixture.recordings.length;
 assert.ok(tracks>2);
 assert.ok(fixture.recordings.every(({animation})=>animation.playState==='paused'),'a background character remains paused after reduced motion is disabled');
 motion.setPaused(false);
 motion.setReducedMotion(true);
 assert.ok(fixture.recordings.every(({animation})=>animation.cancels===1));
 assert.equal(fixture.nodes.get('.avatar-fore')!.style.transform,'translate(0px,0px) rotate(-22deg)');
 motion.setReducedMotion(true);
 assert.equal(fixture.recordings.length,tracks);
 motion.dispose();
 assert.ok(fixture.recordings.every(({animation})=>animation.cancels===1),'already cancelled tracks are not retained');
});

test('changing the resolved species disposes the previous character before the next program',()=>{
 const fixture=motionFixture(),previous=createAnimalThinkingMotion(fixture.root,'otter');
 const first=fixture.recordings.slice();previous.dispose();
 const current=createAnimalThinkingMotion(fixture.root,'owl');
 assert.ok(first.every(({animation})=>animation.cancels===1));
 assert.ok(fixture.recordings.slice(first.length).every(({options})=>options.duration===4800));
 assert.equal(fixture.nodes.get('.avatar-other')!.style.transform,'','old otter-only articulation is cleared');
 current.dispose();
});
