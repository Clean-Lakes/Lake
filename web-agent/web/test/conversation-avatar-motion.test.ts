import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AIView,SessionSnapshot,SpecialistConversation,SuperWorkspace} from '../../shared/contracts';
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

test('synthesis animates the existing Pilot identity only in the originating turn',()=>{
 const at=(second:number)=>new Date(Date.UTC(2026,10,4,0,0,second)).toISOString();
 const snapshot={session:{id:'pilot',title:'Pilot',projectId:'p',workspaceRole:'router',status:'completed'},resources:[],actions:[],evidence:[],
  messages:[
   {id:'source',sessionId:'pilot',role:'user',text:'再检查一次',createdAt:at(0)},
   {id:'report',sessionId:'pilot',role:'assistant',text:'已完成核对。',createdAt:at(3),replyToMessageId:'source',
    author:{kind:'specialist',name:'数据库专员',roleId:'db',workerId:'db-worker',sessionId:'db-session',taskId:'task'}},
   {id:'next',sessionId:'pilot',role:'user',text:'再检查一次',createdAt:at(4)},
  ],
  ai:view('completed',{cards:[
   {id:'handoff',type:'message',status:'completed',content:'已安排核对。',at:at(2),data:{source_message_id:'source',root_turn_id:'source-root'}},
   {id:'next-reply',type:'message',status:'completed',content:'收到新的请求。',at:at(5),data:{source_message_id:'next',root_turn_id:'next-root'}},
  ]}),
 } as SessionSnapshot;
 const round:SpecialistConversation={id:'round',kind:'task-summary',projectId:'p',sessionId:'pilot',sourceMessageId:'source',
  state:'summarizing',title:'复测结论',createdAt:at(3),deadlineAt:at(30),summaryRequested:true,members:[]};
 const render=(change:Partial<SpecialistConversation>={},pilotConnected=true)=>{
  const current={...round,...change},task=current.kind==='task-summary';
  const assignments=['db','ops'].map(roleId=>({roleId,workerId:roleId+'-worker',sessionId:roleId+'-session',dispatch:{state:'queued'}}));
  const operation={id:'route',type:'operation',status:'completed',at:at(1),title:task?'route_work':'convene_specialists',
   content:JSON.stringify(task?{eventId:'event',partKey:'check',action:'create',taskId:'task',assignments}:current),
   data:{...snapshot.ai!.cards[0]!.data as object,arguments:{event_id:'event',part_key:'check',action:'create',role_ids:['db','ops']}}};
  const pilotWorkspace:SuperWorkspace={active:true,project:{projectId:'p',routerSessionId:'pilot',version:1},workers:[],
   conversations:[{...current,summary:{id:'conclusion',taskId:task?'task':undefined}}]};
  const view={...snapshot,ai:{...snapshot.ai!,cards:[operation,...snapshot.ai!.cards]}};
  return renderToStaticMarkup(createElement(AITranscript,{snapshot:view,pilotWorkspace,pilotConnected,assistantIdentity:{name:'Pilot',pilot:true}}));
 };
 for(const kind of ['task-summary',undefined] as const){
  const html=render({kind});
  assert.equal((html.match(/data-motion="working"/g)??[]).length,1);
  assert.equal((html.match(/data-live-motion="active"/g)??[]).length,2);
  assert.match(html,/data-conversation-entry="handoff"[^>]*><div class="response-identity"><span[^>]+><span[^>]+data-motion="working"/);
 }
 for(const change of [{state:'queued'},{state:'completed'},{state:'failed'},{state:'cancelled'},
  {sourceMessageId:'missing'},{sessionId:'other-session'},{projectId:'other-project'}] as const){
  assert.doesNotMatch(render(change),/data-motion="working"|data-live-motion="active"/);
 }
 const disconnected=render({},false);
 assert.doesNotMatch(disconnected,/data-motion="working"|data-live-motion="active"/);
 assert.match(disconnected,/data-motion="still"/);
 snapshot.messages.push({id:'conclusion',sessionId:'pilot',role:'assistant',text:'复测完成。',createdAt:at(6),replyToMessageId:'source',
  jointReport:{taskId:'task',reportId:'joint-report',kind:'summary'}});
 assert.doesNotMatch(render(),/data-motion="working"|data-live-motion="active"/,'the conclusion can arrive ahead of the workspace snapshot');
});
