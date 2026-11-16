import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LakeStore} from './store';

test('restart retains completed source timings and interrupts the exact unfinished reply without reviving its activity',async t=>{
 const home=await mkdtemp(join(tmpdir(),'lake-pilot-timing-')),data=join(home,'data');
 let store=await LakeStore.open(home,data);
 t.after(async()=>{store.db.close();await rm(home,{recursive:true,force:true});});
 const project=store.createProject('isolated reply timing');
 for(const before of ['running','completed']){
 const session=store.createSession(project.id);
 const a=store.addMessage(session.id,'user','A'),b=store.addMessage(session.id,'user','B'),view=store.view(session.id);
 const saved={messageId:a.id,startedAt:'2026-11-16T00:00:00Z',finishedAt:'2026-11-16T00:00:02Z',status:'completed' as const};
 view.status=before;view.replyStatus='running';view.sourceMessageIds=[b.id];
 view.replyTimings=[saved,{messageId:b.id,startedAt:'2026-11-16T00:00:03Z',finishedAt:'',status:'running'}];
 store.put('views',session.id,view);store.db.close();store=await LakeStore.open(home,data);
 const snapshot=store.snapshot(session.id);
 assert.deepEqual(snapshot.replyTimings?.[0],saved);
 assert.equal(snapshot.replyTimings?.[1]?.messageId,b.id);assert.equal(snapshot.replyTimings?.[1]?.status,'interrupted');
 assert.ok(snapshot.replyTimings?.[1]?.finishedAt);assert.equal(snapshot.ai?.status,before==='running'?'interrupted':'completed');assert.notEqual(snapshot.ai?.replyStatus,'running');
 assert.deepEqual(snapshot.ai?.sourceMessageIds,[b.id]);assert.equal(snapshot.messages.length,2);
 }
});
