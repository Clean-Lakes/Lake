import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SpecialistConversation,SuperWorkspace,SessionSnapshot,Message} from '../../shared/contracts';
import {PilotConversationProgress} from '../src/PilotConversationProgress';
import {superPilotActivity} from '../src/superPilotActivity';
import {AITranscript} from '../src/AIPanel';

const round:SpecialistConversation={id:'round',projectId:'project',sessionId:'pilot',sourceMessageId:'human',title:'全员报数',state:'running',createdAt:'2026-11-13T00:00:00Z',deadlineAt:'2026-11-13T00:02:00Z',
 members:[{id:'a',roleId:'a',roleName:'运维专员',sessionId:'speaker-a',channelSessionId:'channel-a',state:'replied'},
 {id:'b',roleId:'b',roleName:'数据库专员',sessionId:'speaker-b',channelSessionId:'channel-b',state:'running'},
 {id:'c',roleId:'c',roleName:'发布专员',sessionId:'speaker-c',channelSessionId:'channel-c',state:'queued'}]};
const workspace:SuperWorkspace={active:true,project:{projectId:'project',routerSessionId:'pilot',version:1},workers:[],conversations:[round]};

test('real replied counts and every outstanding specialist remain visible, including failures after summary',()=>{
 const html=renderToStaticMarkup(createElement(PilotConversationProgress,{rounds:[round]}));
 assert.match(html,/1 \/ 3 位干员已回应/);assert.match(html,/数据库专员 · 尚未回应，正在回复/);assert.match(html,/发布专员 · 尚未回应，等待唤醒/);
 const failed={...round,state:'completed' as const,members:round.members.map(member=>member.state==='running'?{...member,state:'timed_out' as const}:member)};
 const settled=renderToStaticMarkup(createElement(PilotConversationProgress,{rounds:[failed]}));
 assert.match(settled,/数据库专员 · 未回应，等待超时/);assert.match(settled,/Pilot 已汇总/);
 const offline=renderToStaticMarkup(createElement(PilotConversationProgress,{rounds:[round],connected:false}));
 assert.match(offline,/正在重连/);assert.doesNotMatch(offline,/status-text--active/);
});

test('Lake Island follows dialogue even after the routing response, and stops when the round settles',()=>{
 const session={id:'pilot',projectId:'project'};
 assert.equal(superPilotActivity(workspace,session)?.status,'investigating');
 assert.equal(superPilotActivity(workspace,session)?.label,'2 位干员尚未回应');
 assert.equal(superPilotActivity({...workspace,conversations:[{...round,state:'summarizing'}]},session)?.label,'Pilot 正在汇总干员回应');
 assert.equal(superPilotActivity({...workspace,conversations:[{...round,state:'completed'}]},session),null);
 assert.equal(superPilotActivity(workspace,session,false)?.animated,false);
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
});
