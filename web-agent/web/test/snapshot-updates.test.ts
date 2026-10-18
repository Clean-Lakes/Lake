import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptSnapshot,reuseUnchanged} from '../src/snapshotUpdates';
import type {SessionSnapshot} from '../../shared/contracts';

test('polling identical JSON retains the catalog and all transcript branches',()=>{
 const before={session:{id:'s'},cursor:10,ai:{cards:[{id:'reply',content:'正文'}]},sre:{tasks:[{id:'task',messages:[{body:'已采集'}]}]}} as unknown as SessionSnapshot;
 assert.equal(acceptSnapshot(before,structuredClone(before)),before);
 const next=structuredClone(before);next.cursor++;
 const accepted=acceptSnapshot(before,next);
 assert.equal(accepted.ai,before.ai);assert.equal(accepted.sre,before.sre);
 const catalog={sessions:[{id:'s',title:'会话'}],resources:[]};
 assert.equal(reuseUnchanged(catalog,structuredClone(catalog)),catalog);
});
test('late poll cannot roll a finished reply back to an earlier running snapshot',()=>{
 const latest={session:{id:'s'},cursor:12,ai:{status:'completed',cards:[{content:'完整正文'}]}} as unknown as SessionSnapshot;
 const stale={...latest,cursor:11,ai:{status:'running',cards:[{content:'完整'}]}} as unknown as SessionSnapshot;
 assert.equal(acceptSnapshot(latest,stale),latest);
 assert.equal(acceptSnapshot(latest,{...stale,session:{id:'other'}} as SessionSnapshot).session.id,'other');
});
test('equal cursor can still carry a new engine delta, retaining unrelated branches',()=>{
 const before={session:{id:'s'},cursor:10,ai:{cards:[{content:'已收到'}]},resources:[]} as unknown as SessionSnapshot;
 const next=structuredClone(before);next.ai!.cards[0]!.content+='新的内容';
 const accepted=acceptSnapshot(before,next);
 assert.equal(accepted.resources,before.resources);assert.equal(accepted.ai!.cards[0]!.content,'已收到新的内容');
});
