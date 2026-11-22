import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard,SpecialistConversation,SuperWorkspace,SessionSnapshot,Message} from '../../shared/contracts';
import {PilotConversationProgress} from '../src/PilotConversationProgress';
import {ReplyFooter} from '../src/ReplyFooter';
import {superPilotActivity} from '../src/superPilotActivity';
import {AITranscript} from '../src/AIPanel';

const round:SpecialistConversation={id:'round',projectId:'project',sessionId:'pilot',sourceMessageId:'human',title:'全员报数',state:'running',createdAt:'2026-11-13T00:00:00Z',deadlineAt:'2026-11-13T00:02:00Z',
 members:[{id:'a',roleId:'a',roleName:'运维专员',sessionId:'speaker-a',channelSessionId:'channel-a',state:'replied'},
 {id:'b',roleId:'b',roleName:'数据库专员',sessionId:'speaker-b',channelSessionId:'channel-b',state:'running'},
 {id:'c',roleId:'c',roleName:'发布专员',sessionId:'speaker-c',channelSessionId:'channel-c',state:'queued'}]};
const workspace:SuperWorkspace={active:true,project:{projectId:'project',routerSessionId:'pilot',version:1},workers:[],conversations:[round]};

test('the round groups waiting specialists behind one control and keeps recorded failures',()=>{
 const html=renderToStaticMarkup(createElement(PilotConversationProgress,{round,replies:[]}));
 assert.match(html,/1 位回复中/);assert.match(html,/1 位排队/);assert.match(html,/1 份已收到/);
 assert.doesNotMatch(html,/正在回复…|等待回应/);
 assert.match(html,/-waiting" hidden=""/);
 const failed={...round,state:'completed' as const,members:round.members.map(member=>member.state==='running'?{...member,state:'timed_out' as const}:member)};
 const settled=renderToStaticMarkup(createElement(PilotConversationProgress,{round:failed,replies:[]}));
 assert.match(settled,/回应超时/);assert.match(settled,/1 份专员报告/);
 const offline=renderToStaticMarkup(createElement(PilotConversationProgress,{round,replies:[],connected:false}));
 assert.match(offline,/正在重连/);assert.doesNotMatch(offline,/data-active="true"/);
});

test('a stored authentication failure stays visible after completion and while offline',()=>{
 const failed:SpecialistConversation={...round,state:'completed',members:[
  round.members[0]!,{...round.members[1]!,state:'failed',reason:'模型服务鉴权失败（HTTP 401）'},
 ]};
 for(const connected of [true,false]){
  const html=renderToStaticMarkup(createElement(PilotConversationProgress,{round:failed,replies:[],connected}));
  const text=html.replace(/<[^>]*>/g,'');
  assert.match(text,/1 份专员报告/);assert.match(text,/1 位未回应/);
  assert.equal((text.match(/模型服务鉴权失败（HTTP 401）/g)??[]).length,1);
  assert.doesNotMatch(text,/回应失败：|等待重新连接/);
 }
});

test('the report disclosure contains the execution process and duration',()=>{
 const process=createElement(ReplyFooter,{duration:'14秒',action:{controls:'execution',onClick:()=>{}}});
 const completed:SpecialistConversation={...round,state:'completed',members:[round.members[0]!]};
 const html=renderToStaticMarkup(createElement(PilotConversationProgress,{round:completed,replies:['专员原话'],process}));
 assert.match(html,/aria-expanded="false" aria-controls="([^"]+-replies)"/);
 assert.match(html,/-replies" class="pilot-report-body" aria-hidden="true" inert=""><div class="pilot-report-items"><div class="pilot-conversation-process">/);
 assert.match(html,/查看执行过程/);
 assert.match(html,/>14 秒</);
 assert.ok(html.indexOf('查看执行过程')<html.indexOf('专员原话'));
 const failed:SpecialistConversation={...completed,members:[{...completed.members[0]!,state:'failed'}]};
 const withoutReports=renderToStaticMarkup(createElement(PilotConversationProgress,{round:failed,replies:[],process}));
 assert.doesNotMatch(withoutReports,/-replies" class="pilot-report-body" aria-hidden=/);
 assert.match(withoutReports,/查看执行过程/);
});

test('the report list can fold at synthesis only after the delivered replies are present',()=>{
 const summarizing:SpecialistConversation={...round,state:'summarizing',members:round.members.map(member=>({...member,state:'replied'}))};
 const partial=renderToStaticMarkup(createElement(PilotConversationProgress,{round:summarizing,replies:['第一份','第二份']}));
 assert.match(partial,/aria-expanded="true" aria-controls="[^"]+-replies"/);
 const delivered=renderToStaticMarkup(createElement(PilotConversationProgress,{round:summarizing,replies:['第一份','第二份','第三份']}));
 assert.match(delivered,/aria-expanded="false" aria-controls="[^"]+-replies"/);
 assert.match(delivered,/3 份专员报告/);
 assert.match(delivered,/Pilot 正在总结/);
 const workspaceBehind=renderToStaticMarkup(createElement(PilotConversationProgress,{round,summaryDelivered:true,
   replyMemberIds:new Set(['a','b']),replies:['第一份','第二份']}));
 assert.match(workspaceBehind,/aria-expanded="false" aria-controls="[^"]+-replies"/);
 assert.match(workspaceBehind,/2 份专员报告/);
 assert.doesNotMatch(workspaceBehind,/位回复中|位排队/);
});

test('Lake Island follows dialogue even after the routing response, and stops when the round settles',()=>{
 const session={id:'pilot',projectId:'project'};
 assert.equal(superPilotActivity(workspace,session)?.status,'investigating');
 assert.equal(superPilotActivity(workspace,session)?.label,'2 位专员尚未回应');
 assert.equal(superPilotActivity({...workspace,conversations:[{...round,state:'summarizing'}]},session)?.label,'Pilot 正在汇总专员回应');
 assert.equal(superPilotActivity({...workspace,conversations:[{...round,state:'completed'}]},session),null);
 assert.equal(superPilotActivity(workspace,session,false)?.animated,false);
 assert.equal(superPilotActivity(workspace,session,false)?.idleLabel,'重连中');
 assert.equal(superPilotActivity(workspace,{id:'other',projectId:'project'}),null);
});

test('progress stays with its originating turn and actual speakers retain their own identities',()=>{
 const human:Message={id:'human',sessionId:'pilot',role:'user',text:'全部干员报数',createdAt:round.createdAt};
 const reply:Message={id:'reply',sessionId:'pilot',role:'assistant',text:'1，运维专员到！',createdAt:'2026-11-13T00:00:02Z',
  author:{kind:'specialist',name:'运维专员',roleId:'a',workerId:'a',sessionId:'speaker-a',channelSessionId:'channel-a',conversationId:round.id},
  conversation:{id:round.id,sourceMessageId:human.id,kind:'reply'}};
 const later:Message={...human,id:'later',text:'另一个问题',createdAt:'2026-11-13T00:00:03Z'};
 const snapshot={session:{id:'pilot',projectId:'project',workspaceRole:'router'},messages:[human,reply,later],resources:[],actions:[],ai:{session:'pilot',status:'completed',cards:[],cardsOffset:0}} as unknown as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot,pilotWorkspace:workspace,assistantIdentity:{name:'Pilot',pilot:true}}));
 assert.match(html,/<strong>运维专员<\/strong>/);assert.ok(html.indexOf('data-conversation-id="round"')<html.indexOf('class="user-message-text">另一个问题'));
 assert.equal((html.match(/data-conversation-id="round"/g)??[]).length,1);
 assert.equal((html.match(/1，运维专员到！/g)??[]).length,1);
 assert.ok(html.indexOf('pilot-conversation-replies')<html.indexOf('1，运维专员到！'));
});

test('automatic conversation summaries stay in storage while requested synthesis and real speaker replies remain visible',()=>{
 const human:Message={id:'human',sessionId:'pilot',role:'user',text:'全部干员报数',createdAt:round.createdAt};
 const legacy:Message={id:'automatic',sessionId:'pilot',role:'assistant',text:'AUTOMATIC_REPEATED_ROSTER',createdAt:'2026-11-13T00:00:02Z',conversation:{id:round.id,sourceMessageId:human.id,kind:'summary'}};
 const requested:Message={...legacy,id:'requested',text:'REQUESTED_INTEGRATED_CONCLUSION',conversation:{...legacy.conversation!,summaryRequested:true}};
 const plain:Message={...legacy,id:'ordinary',text:'ORDINARY_PILOT_REPLY',conversation:undefined};
 const snapshot={session:{id:'pilot',projectId:'project',workspaceRole:'router'},messages:[human,legacy,requested,plain],resources:[],actions:[],ai:{session:'pilot',status:'completed',cards:[],cardsOffset:0}} as unknown as SessionSnapshot;
 const before=JSON.stringify(snapshot),html=renderToStaticMarkup(createElement(AITranscript,{snapshot,pilotWorkspace:workspace,assistantIdentity:{name:'Pilot',pilot:true}}));
 assert.doesNotMatch(html,/AUTOMATIC_REPEATED_ROSTER/);assert.match(html,/REQUESTED_INTEGRATED_CONCLUSION/);assert.match(html,/ORDINARY_PILOT_REPLY/);
 assert.equal(JSON.stringify(snapshot),before);
});

test('a dialogue conclusion replaces its acknowledgement in the original Pilot message even after a later user turn',()=>{
 const at=(second:number)=>new Date(Date.parse(round.createdAt)+second*1000).toISOString();
 const user:Message={id:'human',sessionId:'pilot',role:'user',text:'请专员报到',createdAt:at(0)};
 const later:Message={...user,id:'later',text:'另一个独立问题',createdAt:at(4)};
 const answer:Message={...later,id:'later-answer',role:'assistant',text:'这里是独立回答',createdAt:at(5),replyToMessageId:later.id};
 const summary:Message={id:'conclusion',sessionId:'pilot',role:'assistant',text:'专员们已经报到。',createdAt:at(9),
  conversation:{id:round.id,sourceMessageId:user.id,kind:'summary',summaryRequested:true}};
 const data={root_turn_id:'invite-root',source_message_id:user.id};
 const cards:AICard[]=[
  {id:'invite',type:'operation',title:'convene_specialists',status:'completed',at:at(1),content:JSON.stringify(round),data},
  {id:'acknowledgement',type:'message',status:'completed',at:at(2),content:'已经请大家逐一回应。',data},
 ];
 const snapshot={session:{id:'pilot',projectId:'project',workspaceRole:'router'},messages:[user,later,answer],resources:[],actions:[],
  ai:{session:'pilot',status:'completed',cards,cardsOffset:0}} as unknown as SessionSnapshot;
 const render=(value:SessionSnapshot)=>renderToStaticMarkup(createElement(AITranscript,{snapshot:value,assistantIdentity:{name:'Pilot',pilot:true}}));
 const readBody=(html:string)=>html.split('class="turn-execution-details')[0]!;
 assert.match(readBody(render(snapshot)),/data-conversation-entry="acknowledgement".*已经请大家逐一回应。/);
 const completed={...snapshot,messages:[...snapshot.messages,summary]};
 const saved=JSON.stringify(completed),html=render(completed),body=readBody(html);
 assert.match(body,/data-conversation-entry="acknowledgement".*专员们已经报到。/);
 assert.doesNotMatch(body,/已经请大家逐一回应。/);
 assert.equal((body.match(/<strong>Pilot<\/strong>/g)??[]).length,1);
 assert.match(html,/turn-process-prose[^]*已经请大家逐一回应。/);
 assert.ok(html.indexOf(summary.text)<html.indexOf(later.text));
 assert.match(html,/这里是独立回答/);
 assert.equal(JSON.stringify(completed),saved);

 const workspaceDuring={...workspace,conversations:[{...round,state:'summarizing' as const,summaryRequested:true,
  summary:{id:summary.id,preview:{seq:42,text:'专员们已经'}}}]};
 const during=renderToStaticMarkup(createElement(AITranscript,{snapshot,pilotWorkspace:workspaceDuring,assistantIdentity:{name:'Pilot',pilot:true}}));
 assert.equal((during.match(/data-pilot-summary="conclusion"/g)??[]).length,1);
 assert.match(readBody(during),/data-live-motion="active".*pilot-summary-cursor/);
 assert.match(readBody(during).replace(/<[^>]*>/g,''),/专员们已经/);
 assert.ok(during.indexOf('data-pilot-summary="conclusion"')<during.indexOf(later.text));

 const stale=renderToStaticMarkup(createElement(AITranscript,{snapshot:completed,pilotWorkspace:workspaceDuring,assistantIdentity:{name:'Pilot',pilot:true}}));
 assert.equal((stale.match(/data-pilot-summary="conclusion"/g)??[]).length,1);
 assert.match(readBody(stale),/专员们已经报到。/);
 assert.doesNotMatch(readBody(stale),/pilot-summary-cursor/);

 for(const result of [
  {...summary,conversation:{...summary.conversation!,id:'another-round'}},
  {...summary,conversation:{...summary.conversation!,kind:'notice' as const}},
 ]){
  assert.match(readBody(render({...snapshot,messages:[...snapshot.messages,result]})),/已经请大家逐一回应。/);
 }
 const mixed={...completed,ai:{...completed.ai!,cards:[{id:'lookup',type:'operation',title:'inspect_host',
  status:'completed',at:at(0.5),data},...cards]}};
 assert.match(readBody(render(mixed)),/已经请大家逐一回应。/);
});
