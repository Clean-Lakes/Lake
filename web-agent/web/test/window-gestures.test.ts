import test from 'node:test';
import assert from 'node:assert/strict';
import {windowGestures} from '../src/windowGestures';
const event=(clientX=300,clientY=24,button=0)=>({clientX,clientY,button,preventDefault(){}});
test('clicks stay in the webview so two clicks can maximize',()=>{
 const actions:string[]=[];const gestures=windowGestures(()=>true,action=>actions.push(action));
 gestures.down(event());gestures.cancel();gestures.down(event());gestures.cancel();
 assert.deepEqual(actions,[]);gestures.doubleClick(event());assert.deepEqual(actions,['maximize']);
});
test('a drag starts after the threshold and is handed off exactly once',()=>{
 const actions:string[]=[];const gestures=windowGestures(()=>true,action=>actions.push(action));
 gestures.down(event());gestures.move(event(303));assert.deepEqual(actions,[]);
 gestures.move(event(304));gestures.move(event(330));assert.deepEqual(actions,['drag']);
});
test('buttons, overlays, non-primary clicks and cancelled drags never issue commands',()=>{
 const actions:string[]=[];let eligible=false;const gestures=windowGestures(()=>eligible,action=>actions.push(action));
 gestures.down(event());gestures.move(event(330));gestures.doubleClick(event());
 eligible=true;gestures.down(event(300,24,2));gestures.move(event(330));gestures.doubleClick(event(300,24,2));
 gestures.down(event());gestures.cancel();gestures.move(event(330));assert.deepEqual(actions,[]);
});
