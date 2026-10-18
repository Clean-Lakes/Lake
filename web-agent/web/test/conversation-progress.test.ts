import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard,SessionSnapshot} from '../../shared/contracts';
import {conversationGroups} from '../src/conversation-progress-model';
import {AITranscript} from '../src/AIPanel';

const at='2026-10-18T08:00:00Z';
const card=(id:string,type:string,status='completed',content=id)=>({id,at,card:{id,at,type,status,content,title:'shell',data:{arguments:{command:'uptime'},target:'测试主机'}}});
const user={id:'user',at,message:{id:'user',role:'user',text:'检查状态',createdAt:at} as SessionSnapshot['messages'][number]};
test('interleaved commentary and tools share one process; final streaming reply stays outside',()=>{
 const entries=[user,card('thought','thinking'),card('first','message'),card('op1','operation'),card('second','message'),card('op2','shell','running'),card('thought2','thinking'),card('final','message','running')];
 const saved=JSON.stringify(entries);
 const groups=conversationGroups(entries);
 assert.deepEqual(groups.map(g=>[g.progress,g.entries.map(e=>e.id)]),[[false,['user']],[true,['thought','first','op1','second','op2','thought2']],[false,['final']]]);
 assert.equal(JSON.stringify(entries),saved);
});
test('no prose guessing: a standalone final answer or scope question never becomes progress',()=>{
 const question={id:'question',at,message:{...user.message!,role:'assistant',text:'请确认范围'}};
 assert.ok(conversationGroups([card('reply','message'),question]).every(g=>!g.progress));
});
test('approvals, failures, unknown outcomes, stopped operations and native notices break compact groups',()=>{
 for(const status of ['pending','failed','unknown','interrupted','cancelled','not_executed','background_running']){
  const entries=[card('before','message'),card('attention','operation',status),card('next','message'),card('safe','operation')];
  const groups=conversationGroups(entries);
  assert.ok(groups.find(g=>g.entries.some(e=>e.id==='attention'))?.progress===false,status);
  assert.deepEqual(groups.find(g=>g.progress)?.entries.map(e=>e.id),['next','safe']);
 }
 const native={id:'approval',at,action:{id:'approval'} as SessionSnapshot['actions'][number]};
 const groups=conversationGroups([card('one','operation'),native,user,card('two','operation'),card('error','error','failed')]);
 assert.deepEqual(groups.filter(g=>g.progress).map(g=>g.entries.map(e=>e.id)),[['one'],['two']]);
 assert.ok(!groups.find(g=>g.entries.some(e=>e.id==='error'))!.progress);
});
test('child runs and SRE entries stay under their own controls',()=>{
 const run={id:'run',at,agentRun:{id:'run'} as NonNullable<Parameters<typeof conversationGroups>[0][number]['agentRun']>};
 const sre={id:'sre',at,sre:{} as NonNullable<Parameters<typeof conversationGroups>[0][number]['sre']>};
 const groups=conversationGroups([card('dispatch','operation'),run,sre,card('reply','message')]);
 assert.ok(groups.every(g=>!g.progress));
 assert.deepEqual(groups[0]!.entries.map(e=>e.id),['dispatch','run']);
});
test('many tool rounds render one two-line preview, final reply and single status; activity retains all records',()=>{
 const s={session:{id:'s'},messages:[user.message],actions:[],resources:[],replyTimings:[{messageId:user.message!.id,startedAt:at,finishedAt:'2026-10-18T08:01:00Z',status:'completed'}],ai:{session:'s',status:'completed',cardsOffset:0,turns:1,cards:Array.from({length:12},(_,i)=>[card(`note${i}`,'message','completed',`说明 ${i}` ).card,card(`tool${i}`,'operation').card]).flat().concat([card('final','message','completed','最终结论').card])}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.equal((html.match(/class="conversation-progress"/g)||[]).length,1);
 assert.ok(html.includes('说明 11')&&!html.includes('说明 0'));
 assert.ok(html.includes('最终结论')&&html.includes('12 项操作'));
 assert.equal((html.match(/turn-status-text/g)||[]).length,1);
 const activity=renderToStaticMarkup(createElement(AITranscript,{snapshot:s,mode:'activity'}));
 assert.ok(!activity.includes('conversation-progress-toggle'));
 assert.equal((activity.match(/class="thinking-timeline /g)||[]).length,1);
});
