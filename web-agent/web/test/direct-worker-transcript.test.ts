import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard,Message,SessionSnapshot} from '../../shared/contracts';
import {AITranscript} from '../src/AIPanel';
import {orderedTranscript,transcriptTurns} from '../src/timeline';
import {workerTranscriptCards,workerConversationTurns,isDeliveredWorkerInterim} from '../src/workerTranscript';

const at=(s:number)=>new Date(1700000000000+s*1000).toISOString();
const card=(id:string,root:string,type:string,n:number,content:string):AICard=>({id,type,title:type==='operation'?'work_finish':'',content,status:'completed',at:at(n),data:{root_turn_id:root}});
const report=(id:string,root:string,n:number,text:string):Message=>({id,role:'assistant',text,sessionId:'role-channel',createdAt:at(n),author:{kind:'specialist',name:'运维专员',workerId:'worker',sessionId:'execution',taskId:'task',channelSessionId:'role-channel',rootTurnId:root}});
const cards=[card('start1','failed','message',0,'准备开始'),card('failure','failed','error',1,'前一次遇到错误'),
  card('start2','retry','message',3,'重新采样'),card('finish','retry','operation',4,'已提交'),
  card('sdk-copy','retry','message',5,'两台采样完成')];
const replies=[report('failed-report','failed',2,'首次未完成'),report('success-report','retry',6,'两台采样完成')];
const snapshot={session:{id:'execution',workspaceRole:'worker'},resources:[],messages:[],actions:[],
  ai:{status:'completed',cards,cardsOffset:0},superagent:{task:{taskId:'task'},deliveredReplies:replies}} as unknown as SessionSnapshot;

test('direct Worker transcript shows host-delivered results once per root with earlier errors and process disclosure',()=>{
 const projected=workerTranscriptCards(snapshot,cards,0),entries=orderedTranscript(snapshot,projected.cards,0);
 const rounds=workerConversationTurns(transcriptTurns(entries),projected.reported);
 assert.deepEqual(rounds.map(r=>r.filter(e=>e.card&&[...projected.reported.values()].some(c=>c.id===e.id)).map(e=>e.id)),[['failed-report'],['success-report']]);
 assert.deepEqual(rounds.flat().filter(e=>isDeliveredWorkerInterim(e,projected.reported)).map(e=>e.id),['start1','start2']);
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
 assert.equal(html.split('两台采样完成').length-1,1);
 assert.equal(html.split('首次未完成').length-1,1);
 assert.match(html,/aria-hidden="true"[^>]*[^]*重新采样/);assert.match(html,/前一次遇到错误/);
 assert.equal(snapshot.ai!.cards.length,5);
});

test('an old unloaded root, channel transcript or unconfirmed task cannot fabricate a final reply',()=>{
 const p=workerTranscriptCards(snapshot,cards.slice(2),3);assert.deepEqual([...p.reported.keys()],['retry']);
 const empty=workerTranscriptCards({...snapshot,superagent:{...snapshot.superagent!,deliveredReplies:[]}},cards,0);assert.equal(empty.cards,cards);
 const role=workerTranscriptCards({...snapshot,session:{...snapshot.session,workspaceRole:'role'}},cards,0);assert.equal(role.cards,cards);
});
