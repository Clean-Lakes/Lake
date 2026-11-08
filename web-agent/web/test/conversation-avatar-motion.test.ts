import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AIView,SessionSnapshot,SuperWorkspace} from '../../shared/contracts';
import {conversationActivity,conversationAvatarMotion} from '../src/superAgentPresentation';
import {PilotWorkspace} from '../src/PilotWorkspace';
import {AITranscript} from '../src/AIPanel';
import {ReplyIdentity} from '../src/ReplyIdentity';
import {ReplyDuration} from '../src/ReplyDuration';

const view=(status:string,extra:Partial<AIView>={}):AIView=>({session:'pilot',status,cards:[],usage:{},profile:'',turns:1,cardsOffset:0,totalCards:0,...extra} as AIView);
test('actual replies work despite old blocked goals; questions and operation approvals stop the work action',()=>{
 assert.equal(conversationAvatarMotion(conversationActivity(view('blocked',{replyStatus:'running'})),'blocked'),'working');
 for(const waiting of [{status:'waiting_approval'},{status:'waiting_input'},{question:{}},{pending:{}},{pendingApprovals:[{}]}]){
  assert.equal(conversationAvatarMotion(conversationActivity(view('running',waiting as Partial<AIView>))),'still');
 }
 for(const status of ['completed','cancelled','failed','paused','blocked'])assert.equal(conversationActivity(view(status)),'idle');
 assert.equal(conversationAvatarMotion('idle','paused'),'still');
 assert.equal(conversationAvatarMotion('idle','completed'),'idle');
});
test('sidebar activity affects only the exact Pilot or specialist source identity',()=>{
 const channel=(id:string)=>({id,roleId:id,sessionId:'channel-'+id,roleName:'同名专员',projectId:'p',revision:1,createdAt:'',running:false});
 const workspace:SuperWorkspace={active:true,project:{projectId:'p',routerSessionId:'pilot',version:1},channels:[channel('a'),channel('b')],workers:[]};
 const motions=(sessionId:string,state:'running'|'waiting'|'idle')=>[...renderToStaticMarkup(createElement(PilotWorkspace,{workspace,error:'',selectedId:sessionId,activity:{sessionId,state},onPilot(){},onWorker(){}})).matchAll(/data-motion="([^"]+)"/g)].map(match=>match[1]);
 assert.deepEqual(motions('channel-a','running'),['idle','working','idle']);
 assert.deepEqual(motions('channel-a','waiting'),['idle','still','idle']);
 assert.deepEqual(motions('pilot','running'),['working','idle','idle']);
 assert.deepEqual(motions('other-project-channel','running'),['idle','idle','idle']);
 assert.deepEqual(motions('channel-a','idle'),['idle','idle','idle']);
});
test('thinking avatar and newest visible sender group animate; historical replies and reports keep idle motion',()=>{
 const start='2026-11-04T00:00:00Z';
 const snapshot={session:{id:'pilot',title:'Pilot',projectId:'p',status:'investigating'},resources:[],messages:[{id:'u',sessionId:'pilot',role:'user',text:'查询',createdAt:start}],actions:[],evidence:[],ai:view('running',{turnStartedAt:start,cards:[{id:'first',type:'message',status:'completed',content:'先查一下。',at:start},{id:'latest',type:'message',status:'running',content:'正在核对。',at:'2026-11-04T00:00:02Z'}]})} as unknown as SessionSnapshot;
 snapshot.messages.unshift({id:'old-user',sessionId:'pilot',role:'user',text:'旧话题',createdAt:'2026-11-03T00:00:00Z'},{id:'old-reply',sessionId:'pilot',role:'assistant',text:'历史结果。',createdAt:'2026-11-03T00:00:01Z'});
 const render=()=>renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:'Pilot',pilot:true}}));
 const html=render();
 assert.equal((html.match(/data-motion="working"/g)||[]).length,1);
 assert.match(html,/data-motion="idle"/);
 assert.ok(html.includes('data-conversation-entry="latest" class="ai-response is-reply-continuation"'));
 assert.match(html,/data-conversation-entry="first"[\s\S]*?data-motion="working"/);
 snapshot.ai!.status='completed';
 assert.doesNotMatch(render(),/data-motion="working"/);
 snapshot.ai!.status='waiting_approval';
 assert.doesNotMatch(render(),/data-motion="working"/);
 assert.match(render(),/data-motion="still"/);
 const report=renderToStaticMarkup(createElement(ReplyIdentity,{identity:{name:'Pilot',pilot:true},motion:'working',author:{kind:'specialist',roleId:'a',name:'发布专员',workerId:'worker-a',sessionId:'worker-session',taskId:'task'}}));
 assert.match(report,/data-motion="idle"/);assert.doesNotMatch(report,/data-motion="working"/);
 const thinking=renderToStaticMarkup(createElement(ReplyDuration,{assistantIdentity:{name:'Pilot',pilot:true},view:view('running'),latestUserAt:start}));
 assert.match(thinking,/data-motion="working"/);
});
