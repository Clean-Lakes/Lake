import assert from 'node:assert/strict';
import test from 'node:test';
import {createReplyIdentityFocus} from '../src/replyIdentityFocus';

// Ref detachment happens before DOM removal; the browser then falls back to body.
// Keep those operations separate to exercise focus changes during the commit.
function fixture(){
 const body={},document={body,activeElement:body as object};
 const moves:unknown[]=[];
 const button=()=>({ownerDocument:document,isConnected:true,focus(options?:FocusOptions){document.activeElement=this;moves.push(options);}} as unknown as HTMLButtonElement);
 const focus=createReplyIdentityFocus(),old=button();
 focus.setButton('worker/task',old);focus.finishCommit('worker/task');
 const detach=()=>{focus.setButton('worker/task',null);old.isConnected=false;if(document.activeElement===old)document.activeElement=body;};
 return {focus,document,button,old,moves,detach};
}

test('focused specialist entry follows thinking-to-content and content-to-thinking replacement without scrolling',()=>{
 for(const transition of ['prose','tool','waiting','thinking']){
  const f=fixture(),next=f.button();f.document.activeElement=f.old;
  f.detach();f.focus.setButton('worker/task',next);f.focus.finishCommit('worker/task');
  assert.equal(f.document.activeElement,next,transition);assert.deepEqual(f.moves,[{preventScroll:true}]);
 }
});

test('ordinary snapshot updates and unfocused entry replacements leave focus alone',()=>{
 const f=fixture(),composer=f.button();f.document.activeElement=composer;
 f.focus.finishCommit('worker/task');assert.equal(f.document.activeElement,composer);
 f.detach();f.focus.setButton('worker/task',f.button());f.focus.finishCommit('worker/task');
 assert.equal(f.document.activeElement,composer);assert.deepEqual(f.moves,[]);
});

test('an intentional focus move during a reply transition wins over restoration',()=>{
 const f=fixture(),composer=f.button();f.document.activeElement=f.old;
 f.detach();f.document.activeElement=composer;f.focus.setButton('worker/task',f.button());f.focus.finishCommit('worker/task');
 assert.equal(f.document.activeElement,composer);assert.deepEqual(f.moves,[]);
});

test('switching worker or task never transfers the old entry focus',()=>{
 for(const owner of ['other-worker/task','worker/other-task']){
  const f=fixture();f.document.activeElement=f.old;f.detach();f.focus.setButton(owner,f.button());f.focus.finishCommit(owner);
  assert.equal(f.document.activeElement,f.document.body);assert.deepEqual(f.moves,[]);
 }
});

test('a removed entry cannot restore stale focus when its navigation later reappears',()=>{
 const f=fixture();f.document.activeElement=f.old;f.detach();f.focus.finishCommit('worker/task');
 f.focus.setButton('worker/task',f.button());f.focus.finishCommit('worker/task');
 assert.equal(f.document.activeElement,f.document.body);assert.deepEqual(f.moves,[]);
});

test('reused or disconnected DOM never receives a synthetic refocus',()=>{
 const f=fixture();f.document.activeElement=f.old;
 f.focus.setButton('worker/task',null);f.focus.setButton('worker/task',f.old);f.focus.finishCommit('worker/task');
 assert.equal(f.document.activeElement,f.old);assert.deepEqual(f.moves,[]);
 f.detach();const next=f.button();next.isConnected=false;
 f.focus.setButton('worker/task',next);f.focus.finishCommit('worker/task');assert.deepEqual(f.moves,[]);
});
