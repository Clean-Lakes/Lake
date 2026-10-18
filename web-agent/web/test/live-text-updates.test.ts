import test from 'node:test';
import assert from 'node:assert/strict';
import {applyLiveText} from '../src/liveTextUpdates';
import {acceptSnapshot} from '../src/snapshotUpdates';
import type {SessionEvent,SessionSnapshot} from '../../shared/contracts';
const snapshot=()=>({session:{id:'s'},cursor:10,messages:[{id:'history'}],sre:{tasks:[]},resources:[],ai:{status:'running',rootTurnId:'turn',cards:[{id:'history',content:'历史',status:'completed'}],totalCards:1,agentRuns:[{id:'role',status:'running'}]}} as unknown as SessionSnapshot);
const event=(textUpdate:SessionEvent['textUpdate'],seq=11)=>({sessionId:'s',seq,type:'message',createdAt:'now',textUpdate} as SessionEvent);
const card=(content:string)=>({target:'card' as const,id:'reply',cardType:'message',content,at:'2026-10-18T10:00:00Z',rootTurnId:'turn'});
test('live card events create once and update only the addressed item without a snapshot',()=>{
 const before=snapshot(),first=applyLiveText(before,event(card('中文👩🏽‍💻')))!;
 assert.equal(first.ai!.cards.at(-1)!.content,'中文👩🏽‍💻');
 assert.equal(first.ai!.totalCards,2);
 const next=applyLiveText(first,event(card('中文👩🏽‍💻 新内容'),12))!;
 assert.equal(next.ai!.totalCards,2);assert.equal(next.ai!.cards.at(-1)!.content,'中文👩🏽‍💻 新内容');
 assert.equal(next.ai!.cards[0],before.ai!.cards[0]);assert.equal(next.messages,before.messages);
 assert.equal(next.sre,before.sre);assert.equal(next.resources,before.resources);assert.equal(next.ai!.agentRuns,before.ai!.agentRuns);
});
test('SRE text events preserve task, audit and history branches, and support a new response identity',()=>{
 const before=snapshot();
 const first=applyLiveText(before,event({target:'agent',id:'role',textId:'text-1',content:'核对中'}))!;
 const next=applyLiveText(first,event({target:'agent',id:'role',textId:'text-2',content:'下一步'},12))!;
 assert.equal(next.ai!.agentRuns![0]!.liveText,'下一步');assert.equal(next.ai!.agentRuns![0]!.liveTextId,'text-2');
 assert.equal(next.sre,before.sre);assert.equal(next.ai!.cards,before.ai!.cards);
});
test('duplicates, out-of-order events and late snapshots cannot erase or duplicate live text',()=>{
 const before=snapshot(),next=applyLiveText(before,event(card('最新正文'),15))!;
 assert.equal(applyLiveText(next,event(card('旧正文'),14)),next);
 assert.equal(applyLiveText(next,event(card('最新正文'),15)),next);
 assert.equal(acceptSnapshot(next,{...before,cursor:14}),next);
});
test('unknown targets, old turns, missing payloads and ended items require canonical snapshot recovery',()=>{
 const before=snapshot();
 assert.equal(applyLiveText(before,event(undefined)),null);
 assert.equal(applyLiveText(before,{...event(card('x')),sessionId:'other'}),null);
 assert.equal(applyLiveText(before,event({...card('x'),rootTurnId:'old'})),null);
 assert.equal(applyLiveText(before,event({target:'agent',id:'missing',textId:'x',content:'x'})),null);
 assert.equal(applyLiveText(before,event({target:'card',id:'history',cardType:'message',rootTurnId:'turn',content:'changed'})),null);
 const ended={...before,ai:{...before.ai!,status:'completed'}};
 assert.equal(applyLiveText(ended,event(card('x'))),null);
});
test('completion wins over queued live frames and final authoritative replacement is immediate',()=>{
 const before=snapshot(),streaming=applyLiveText(before,event(card('部分'),12))!;
 const final=acceptSnapshot(streaming,{...streaming,cursor:13,ai:{...streaming.ai!,status:'completed',cards:streaming.ai!.cards.map(c=>c.id==='reply'?{...c,content:'最终正文',status:'completed'}:c)}});
 assert.equal(applyLiveText(final,event(card('旧部分'),12)),final);
 assert.equal(final.ai!.cards.at(-1)!.content,'最终正文');
});
