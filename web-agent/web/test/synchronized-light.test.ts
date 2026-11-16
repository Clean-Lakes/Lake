import assert from 'node:assert/strict';
import test from 'node:test';
import {synchronizeLightAnimations} from '../src/synchronizedLight';

function animation(animationName:string,startTime:number|null=250,playState:AnimationPlayState='running'){
 let start=startTime;const writes:(number|null)[]=[];
 return {animationName,playState,writes,effect:{delay:-146,duration:3400},get startTime(){return start;},set startTime(value:number|null){writes.push(value);start=value;}};
}
function root(tracks:ReturnType<typeof animation>[]){
 const reads:GetAnimationsOptions[]=[];
 return {reads,getAnimations(options?:GetAnimationsOptions){reads.push(options??{});return tracks as unknown as Animation[];}};
}

test('header and independently mounted glyphs align to one document origin without changing delays or objects',()=>{
 const header=animation('workspace-header-sweep',100),name=animation('lake-live-text-glow-rise',1800),status=animation('lake-live-text-glow-rise',2800);
 for(const track of [header,name,status])synchronizeLightAnimations(root([track]),true);
 assert.deepEqual([header.startTime,name.startTime,status.startTime],[0,0,0]);
 assert.deepEqual(name.effect,{delay:-146,duration:3400},'per-glyph phase and the shared CSS period stay owned by CSS');
});

test('unrelated commits keep existing clocks while newly appended glyphs join the same phase',()=>{
 const first=animation('lake-live-text-glow-rise'),tracks=[first],element=root(tracks);
 synchronizeLightAnimations(element,true);synchronizeLightAnimations(element,true);
 assert.deepEqual(first.writes,[0]);
 const appended=animation('lake-live-text-glow-rise',4900);tracks.push(appended);
 synchronizeLightAnimations(element,true);
 assert.equal(tracks[0],first);assert.deepEqual(first.writes,[0]);assert.deepEqual(appended.writes,[0]);
 assert.ok(element.reads.every(options=>options.subtree===true));
});

test('paused, hidden, inactive and reduced states never seek a frozen animation; a resumed clock realigns',()=>{
 const track=animation('workspace-header-sweep',100,'paused'),element=root([track]);
 synchronizeLightAnimations(element,true);assert.deepEqual(track.writes,[]);
 track.playState='running';
 for(const inactiveReason of ['stopped','hidden','reduced']){synchronizeLightAnimations(element,false);assert.deepEqual(track.writes,[],inactiveReason);}
 synchronizeLightAnimations(element,true);assert.deepEqual(track.writes,[0]);
 // CSS resumes a paused animation with a shifted start time. Align that new
 // start to the document again instead of preserving a cross-component lag.
 track.startTime=7200;synchronizeLightAnimations(element,true);assert.equal(track.startTime,0);
});

test('forced-color light glyphs participate but unrelated text sweeps, avatars and transitions do not',()=>{
 const forced=animation('lake-live-text-rise',1300),unrelated=['status-text-sweep','lake-avatar-work-body','reply-arrival',''].map(name=>animation(name));
 synchronizeLightAnimations(root([forced,...unrelated]),true);
 assert.deepEqual(forced.writes,[0]);
 for(const track of unrelated)assert.deepEqual(track.writes,[]);
});

test('unmounted and unsupported roots are harmless and inactive roots are not scanned',()=>{
 synchronizeLightAnimations(null,true);
 synchronizeLightAnimations({} as Pick<Element,'getAnimations'>,true);
 const element=root([animation('workspace-header-sweep')]);
 synchronizeLightAnimations(element,false);assert.equal(element.reads.length,0);
});
