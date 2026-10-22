import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptSnapshot,applyConversationMode,reuseUnchanged} from '../src/snapshotUpdates';
import type {SessionSnapshot} from '../../shared/contracts';

test('a saved Plan mode only updates mode and cursor, retaining resource, terminal and transcript objects',()=>{
 const before={session:{id:'s'},cursor:10,conversationMode:'default',resources:[{id:'host'}],resourceTree:[{id:'folder'}],terminals:[{id:'terminal'}],messages:[{id:'question'}],ai:{cards:[{id:'reply',content:'正文'}]}} as unknown as SessionSnapshot;
 const next=applyConversationMode(before,'s',{mode:'plan',cursor:11})!;
 assert.equal(next.conversationMode,'plan');assert.equal(next.cursor,11);
 for(const key of ['session','resources','resourceTree','terminals','messages','ai'] as const)assert.equal(next[key],before[key],key);
 assert.equal(applyConversationMode(next,'s',{mode:'plan',cursor:11}),next);
 assert.equal(before.conversationMode,'default');
});
test('late mode replies and replies for another session cannot overwrite newer conversation state',()=>{
 const before={session:{id:'s'},cursor:12,conversationMode:'default'} as unknown as SessionSnapshot;
 assert.equal(applyConversationMode(before,'s',{mode:'plan',cursor:11}),before);
 assert.equal(applyConversationMode(before,'other',{mode:'plan',cursor:13}),before);
 assert.equal(applyConversationMode(null,'s',{mode:'plan',cursor:13}),null);
 assert.equal(applyConversationMode(before,'s',{mode:'plan',cursor:NaN}),before);
 const next=applyConversationMode(before,'s',{mode:'plan',cursor:13})!;
 assert.equal(acceptSnapshot(next,{...before,cursor:12}),next);
 assert.equal(applyConversationMode(next,'s',{mode:'default',cursor:14})!.conversationMode,'default');
});

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
test('rolling tool pages retain displayed history while applying current tool outcomes',()=>{
 const before={session:{id:'s'},cursor:10,ai:{cardsOffset:7,totalCards:10,cards:[{id:'history',content:'已显示的历史'},{id:'one',status:'running'},{id:'two',status:'running'}]}} as unknown as SessionSnapshot;
 const incoming={session:{id:'s'},cursor:11,ai:{cardsOffset:8,totalCards:11,cards:[{id:'one',status:'completed'},{id:'two',status:'failed'},{id:'three',status:'running'}]}} as unknown as SessionSnapshot;
 const next=acceptSnapshot(before,incoming);
 assert.deepEqual(next.ai!.cards.map(card=>card.id),['history','one','two','three']);
 assert.equal(next.ai!.cards[0],before.ai!.cards[0]);
 assert.equal(next.ai!.cardsOffset,7);
 assert.equal(next.ai!.totalCards,11);
 assert.equal(next.ai!.cards[1]!.status,'completed');
 assert.equal(next.ai!.cards[2]!.status,'failed');
 assert.equal(incoming.ai!.cards.length,3,'network page must remain untouched');
 assert.equal(before.ai!.cards[1]!.status,'running','prior snapshot must remain untouched');
 const again=acceptSnapshot(next,{...incoming,cursor:12,ai:{...incoming.ai!,cardsOffset:9,totalCards:12,cards:[incoming.ai!.cards[1]!,incoming.ai!.cards[2]!,{id:'four',type:'operation',status:'running',at:''}]}});
 assert.deepEqual(again.ai!.cards.map(card=>card.id),['history','one','two','three','four']);
 assert.equal(again.ai!.cardsOffset,7);
 assert.equal(acceptSnapshot(before,{...incoming,session:{id:'other'}} as SessionSnapshot).ai!.cards.length,3,'navigation must not carry history into another session');
 const gap={...incoming,ai:{...incoming.ai!,cardsOffset:100,totalCards:103}};
 assert.equal(acceptSnapshot(before,gap).ai!.cardsOffset,100,'a noncontiguous page must retain its load-earlier boundary');
 const reset={...incoming,ai:{...incoming.ai!,cardsOffset:0,totalCards:1,cards:[incoming.ai!.cards[2]!]}};
 assert.deepEqual(acceptSnapshot(next,reset).ai!.cards.map(card=>card.id),['three'],'an actual shortened history must replace the old view');
});
