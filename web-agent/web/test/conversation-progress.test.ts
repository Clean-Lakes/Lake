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
test('adding a tool appends its own row and never reclassifies the preceding reply',()=>{
 const first=[user,card('first','message','running')];
 const before=conversationGroups(first);
 const later=conversationGroups([...first,card('op1','operation','running'),card('second','message'),card('op2','shell','running')]);
 assert.deepEqual(later.slice(0,before.length),before);
 assert.deepEqual(later.map(g=>[g.progress,g.entries.map(e=>e.id)]),[[false,['user']],[false,['first']],[true,['op1']],[false,['second']],[true,['op2']]]);
});
test('plain answers and scope questions retain their own rows',()=>{
 const question={id:'question',at,message:{...user.message!,role:'assistant',text:'请确认范围'}};
 assert.ok(conversationGroups([card('reply','message'),question]).every(g=>!g.progress));
});
test('operation status changes keep the same row and never absorb preceding text',()=>{
 for(const status of ['running','pending','completed','failed','unknown','interrupted','cancelled','not_executed','background_running']){
  const groups=conversationGroups([card('before','message'),card('tool','operation',status),card('next','message')]);
  assert.deepEqual(groups.map(g=>[g.progress,g.entries.map(e=>e.id)]),[[false,['before']],[true,['tool']],[false,['next']]],status);
 }
 const approval={id:'approval',at,action:{id:'approval'} as SessionSnapshot['actions'][number]};
 assert.deepEqual(conversationGroups([card('one','operation'),approval,user,card('error','error','failed')]).map(g=>g.entries[0]!.id),['one','approval','user','error']);
});
test('child dispatch and SRE entries retain their existing controls',()=>{
 const run={id:'run',at,agentRun:{id:'run'} as NonNullable<Parameters<typeof conversationGroups>[0][number]['agentRun']>};
 const sre={id:'sre',at,sre:{} as NonNullable<Parameters<typeof conversationGroups>[0][number]['sre']>};
 const groups=conversationGroups([card('dispatch','operation'),run,sre,card('reply','message')]);
 assert.ok(groups.every(g=>!g.progress));
 assert.deepEqual(groups[0]!.entries.map(e=>e.id),['dispatch','run']);
});
test('all tool rounds remain visible in order; final reply and duration stay single',()=>{
 const s={session:{id:'s'},messages:[user.message],actions:[],resources:[],replyTimings:[{messageId:user.message!.id,startedAt:at,finishedAt:'2026-10-18T08:01:00Z',status:'completed'}],ai:{session:'s',status:'completed',cardsOffset:0,turns:1,cards:Array.from({length:12},(_,i)=>[card(`note${i}`,'message','completed',`说明 ${i}`).card,card(`tool${i}`,'operation').card]).flat().concat([card('final','message','completed','最终结论').card])}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.ok(html.includes('说明 0')&&html.includes('说明 11')&&html.includes('最终结论'));
 assert.equal((html.match(/data-conversation-entry=/g)||[]).length,25);
 assert.equal((html.match(/class="thinking-timeline /g)||[]).length,12);
 assert.ok(!html.includes('reply-arrival'),'restored rows must not animate');
 assert.equal((html.match(/turn-status-text/g)||[]).length,1);
 const activity=renderToStaticMarkup(createElement(AITranscript,{snapshot:s,mode:'activity'}));
 assert.equal((activity.match(/class="thinking-timeline /g)||[]).length,1);
});
