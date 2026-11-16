import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SessionEvent} from '../../shared/contracts';
import {AITranscript} from '../src/AIPanel';
import {queuesComposerMessage} from '../src/messageQueue';
import {applyLiveText} from '../src/liveTextUpdates';
import {orderedTranscript,replySourceMessageId,transcriptTurns} from '../src/timeline';
import {timingForTurn} from '../src/replyDurationState';
import {islandFixture} from './fixtures/pilot-island-data';

const at=(second:number)=>`2026-11-16T08:00:${String(second).padStart(2,'0')}.000Z`;
function snapshot(){
 const value=islandFixture();value.session.workspaceRole='router';value.session.status='investigating';
 value.messages=[{id:'user-a',sessionId:value.session.id,role:'user',text:'消息 A：检查项目',createdAt:at(0)},
  {id:'user-b',sessionId:value.session.id,role:'user',text:'消息 B：新任务与补充要求',createdAt:at(2)}];
 value.ai={...value.ai!,status:'running',replyStatus:'running',rootTurnId:'root-a',sourceMessageIds:['user-a'],turnStartedAt:at(1),cards:[],cardsOffset:0,totalCards:0,agentRuns:[],pending:undefined,question:undefined};
 value.actions=[];value.replyTimings=[];value.sre=undefined;return value;
}

test('TypeScript Pilot admits new messages while busy even with paused old drafts; other entry points retain their queue rules',()=>{
 const value=snapshot();value.messageQueue={paused:true,revision:1,lastError:'edited draft',items:[{id:'old',text:'未发送的旧草稿',resourceIds:[],images:[],files:[],createdAt:at(0)}]};
 assert.equal(queuesComposerMessage(value,'typescript',true),false);
 assert.equal(queuesComposerMessage(value,'typescript',false),false);
 assert.equal(value.messageQueue.paused,true);assert.equal(value.messageQueue.items.length,1);
 assert.equal(queuesComposerMessage(value,'go',true),true);
 for(const role of ['role','worker'] as const)assert.equal(queuesComposerMessage({...value,session:{...value.session,workspaceRole:role}},'typescript',true),false);
 assert.equal(queuesComposerMessage({...value,session:{...value.session,workspaceRole:undefined}},'typescript',true),true);
});

test('a first streamed packet after B arrives retains A source, root, timing and transcript placement',()=>{
 const value=snapshot(),event={sessionId:value.session.id,seq:value.cursor+1,textUpdate:{target:'card',id:'reply-a',cardType:'message',content:'A 的真实回复',at:at(3),rootTurnId:'root-a'}} as SessionEvent;
 const received=applyLiveText(value,event)!;assert.ok(received);
 assert.deepEqual(received.ai!.cards[0]!.data,{root_turn_id:'root-a',source_message_id:'user-a'});
 const turns=transcriptTurns(orderedTranscript(received,received.ai!.cards,0));
 assert.deepEqual(turns.map(turn=>turn.map(entry=>entry.id)),[['user-a','reply-a'],['user-b']]);
 assert.equal(replySourceMessageId(received),'user-a');assert.equal(timingForTurn(turns[0]!,received)?.messageId,'user-a');
 assert.equal(timingForTurn(turns[1]!,received),undefined,'B never borrows the currently running A status');
});

test('A final assistant copy deduplicates against its own card after B and survives restored pagination',()=>{
 const value=snapshot();value.messages.push({id:'final-a',sessionId:value.session.id,role:'assistant',replyToMessageId:'user-a',text:'A 的准确结论',createdAt:at(4)});
 value.ai!.cards=[{id:'card-a',type:'message',content:'A 的准确结论',status:'completed',at:at(4),data:{root_turn_id:'root-a',source_message_id:'user-a'}}];
 for(const before of [0,20]){
  const turns=transcriptTurns(orderedTranscript(value,value.ai!.cards,before));
  assert.deepEqual(turns.map(turn=>turn.map(entry=>entry.id)),[['user-a','card-a'],['user-b']]);
 }
});

test('saved A timing remains exact after the later B reply starts, instead of ending at B admission',()=>{
 const value=snapshot();value.replyTimings=[{messageId:'user-a',startedAt:at(1),finishedAt:at(6),status:'completed'},
  {messageId:'user-b',startedAt:at(7),finishedAt:'',status:'running'}];
 value.ai!.sourceMessageIds=['user-b'];value.ai!.turnStartedAt=at(7);
 const turns=transcriptTurns(orderedTranscript(value,[],0));
 assert.equal(timingForTurn(turns[0]!,value)?.finishedAt,at(6));
 assert.equal(timingForTurn(turns[1]!,value)?.startedAt,at(7));
});

test('Pilot SSR keeps the in-flight A reply above B and never duplicates its final copy',()=>{
 const value=snapshot();value.ai!.cards=[{id:'reply-a',type:'message',content:'A 的公开进度',status:'running',at:at(3),data:{root_turn_id:'root-a',source_message_id:'user-a'}}];
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:value,assistantIdentity:{name:'Pilot',pilot:true}}));
 assert.ok(html.indexOf('A 的公开进度')<html.indexOf('消息 B：新任务与补充要求'));
 assert.equal((html.match(/A 的公开进度/g)??[]).length,1);
});

test('an unanswered B does not move A thinking indicator, while old snapshots keep their historical fallback',t=>{
 t.mock.method(Date,'now',()=>Date.parse(at(5)));
 const value=snapshot(),html=renderToStaticMarkup(createElement(AITranscript,{snapshot:value,assistantIdentity:{name:'Pilot',pilot:true}}));
 assert.ok(html.includes('turn-thinking-avatar'));
 assert.ok(html.indexOf('turn-thinking-avatar')<html.indexOf('消息 B：新任务与补充要求'));
 value.ai!.sourceMessageIds=undefined;
 assert.equal(replySourceMessageId(value),'user-b');
});
