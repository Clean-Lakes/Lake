import test from 'node:test';
import assert from 'node:assert/strict';
import {applyExternalReplyStageUpdate,applyLiveText} from '../src/liveTextUpdates';
import {acceptSnapshot} from '../src/snapshotUpdates';
import type {ExternalReplyStage,SessionEvent,SessionSnapshot} from '../../shared/contracts';
const snapshot=()=>({session:{id:'s'},cursor:10,messages:[{id:'history'}],sre:{tasks:[]},resources:[],ai:{status:'running',rootTurnId:'turn',cards:[{id:'history',content:'历史',status:'completed'}],totalCards:1,agentRuns:[{id:'role',status:'running'}]}} as unknown as SessionSnapshot);
const event=(textUpdate:SessionEvent['textUpdate'],seq=11)=>({sessionId:'s',seq,type:'message',createdAt:'now',textUpdate} as SessionEvent);
const card=(content:string)=>({target:'card' as const,id:'reply',cardType:'message',content,at:'2026-10-18T10:00:00Z',rootTurnId:'turn'});
test('ACP public text prefixes update only an existing exact root execution card',()=>{
 const before=snapshot();before.ai!.cards.push({id:'acp',type:'operation',status:'running',at:'now',content:'',data:{source:'external_agent',external_run_id:'acp',root_turn_id:'turn'}});
 const prefix={target:'card' as const,id:'acp',cardType:'operation',content:'公开的 Codex 回复',rootTurnId:'turn'};
 const next=applyLiveText(before,event(prefix))!;
 assert.equal(next.ai!.cards.at(-1)!.content,prefix.content);assert.equal(next.ai!.cards.at(-1)!.type,'operation');
 assert.equal(applyLiveText(snapshot(),event(prefix)),null,'an unknown operation never becomes a public message');
 for(const data of [{source:'tool'},{source:'external_agent',external_run_id:'wrong',root_turn_id:'turn'},{source:'external_agent',external_run_id:'acp',root_turn_id:'turn',childSessionId:'child'}]){
  const wrong={...before,ai:{...before.ai!,cards:[{...before.ai!.cards.at(-1)!,data}]}};
  assert.equal(applyLiveText(wrong,event(prefix)),null);
 }
});
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


test('ACP segment prefixes replace public prose without replacing audit content or history nodes',()=>{
 const before=snapshot();before.ai!.cards.push({id:'acp',type:'operation',status:'running',at:'now',content:'过程',data:{source:'external_agent',external_run_id:'acp',root_turn_id:'turn',external_reply:{id:'first',content:'过程'}}});
 const prefix={target:'card' as const,id:'acp',cardType:'operation',content:'过程结论',rootTurnId:'turn',externalReply:{id:'final',content:'结论'}};
 const next=applyLiveText(before,event(prefix))!;
 assert.equal(next.ai!.cards.at(-1)!.content,'过程结论','original cumulative audit remains available');
 assert.deepEqual((next.ai!.cards.at(-1)!.data as any).external_reply,{id:'final',content:'结论'});
 assert.equal(next.messages,before.messages);assert.equal(next.ai!.cards[0],before.ai!.cards[0]);
 const appended=applyLiveText(next,event({...prefix,content:'过程结论完整',externalReply:{id:'final',content:'结论完整'}},12))!;
 assert.equal((appended.ai!.cards.at(-1)!.data as any).external_reply.content,'结论完整');
 assert.equal(applyLiveText(before,event({...prefix,rootTurnId:'other'})),null);
 assert.equal(applyLiveText(before,event({...card('x'),externalReply:prefix.externalReply})),null,'unrelated message SSE cannot acquire ACP ownership');
});

test('one stream frame can capture multiple ACP phases and in-place updates without losing older prose',()=>{
 const initial=snapshot();initial.superagent={task:{taskId:'task'}} as SessionSnapshot['superagent'];
 initial.ai!.cards.push({id:'acp',type:'operation',status:'running',at:'now',data:{source:'external_agent',external_run_id:'acp',root_turn_id:'turn',taskId:'task'}});
 const phase=(seq:number,stage:ExternalReplyStage):SessionEvent=>({
  ...event(stage.kind==='prose'?{target:'card',id:'acp',cardType:'operation',content:'cumulative audit',rootTurnId:'turn',externalReply:{id:stage.id,content:stage.content}}:undefined,seq),
  externalReplyStageUpdate:{id:'acp',taskId:'task',rootTurnId:'turn',stage:stage.kind==='prose'?{kind:stage.kind,id:stage.id}:stage},
 });
 const messages=[phase(11,{kind:'prose',id:'first',content:'开始检查。'}),
  phase(12,{kind:'tools',id:'tools:1',progress:{total:2,running:2,failed:0}}),
  phase(13,{kind:'prose',id:'next',content:'准备总结'}),
  phase(14,{kind:'tools',id:'tools:1',progress:{total:2,running:0,failed:1}}),
  phase(15,{kind:'prose',id:'next',content:'准备总结。'})];
 const next=messages.reduce((state,item)=>applyExternalReplyStageUpdate(state,item)!,initial);
 const current=next.ai!.cards.at(-1)!,data=current.data as Record<string,unknown>;
 assert.deepEqual(data.external_reply_stages,[{kind:'prose',id:'first',content:'开始检查。'},messages[3]!.externalReplyStageUpdate!.stage,
  {kind:'prose',id:'next',content:'准备总结。'}]);
 assert.equal(next.messages,initial.messages);
 assert.equal(next.ai!.cards[0],initial.ai!.cards[0]);
 assert.equal(current.content,'cumulative audit');
 assert.equal(applyExternalReplyStageUpdate(next,messages[1]!),next);
 assert.equal(applyExternalReplyStageUpdate(next,{...messages[4]!,seq:16,textUpdate:undefined}),null);
 for(const update of [{taskId:'other'},{rootTurnId:'other'},{id:'other'}]){
  const wrong={...messages[3]!,seq:16,externalReplyStageUpdate:{...messages[3]!.externalReplyStageUpdate!,...update}};
  assert.equal(applyExternalReplyStageUpdate(next,wrong),null);
 }
});
