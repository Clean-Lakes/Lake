import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SpecialistReplyAuthor,SuperWorkspace} from '../../shared/contracts';
import type {AgentBackendRef} from '../../shared/external-agents';
import {AgentBackendLogo} from '../src/AgentBackendLogo';
import {PilotWorkspace} from '../src/PilotWorkspace';
import {ReplyIdentity} from '../src/ReplyIdentity';

const render=(backend?:AgentBackendRef)=>renderToStaticMarkup(createElement(AgentBackendLogo,{backend}));
test('Agent logos identify the bound runtime independently of its selected model',()=>{
 const native=render({kind:'native',model:{modelId:'claude-opus'}});
 assert.match(native,/Agent 类型：Lake/);assert.match(native,/sre-avatar-coordinator/);
 assert.doesNotMatch(native,/providers\/|claude-opus/);
 const codex=render({kind:'acp',agent:'codex',model:{modelId:'gpt-6.1-sol'}});
 assert.match(codex,/Agent 类型：Codex/);assert.match(codex,/src="\/providers\/openai.svg"/);
 assert.doesNotMatch(codex,/>Codex<|gpt-6.1-sol/);
 assert.equal(render(),'', 'unknown historical identity does not become Lake or Codex');
 const retired=render({kind:'acp',agent:'runtime-acp'});
 assert.match(retired,/已移除的 Agent/);assert.doesNotMatch(retired,/providers\//);
});

test('sidebar logos use the current role default even when a previous worker used a different Agent',()=>{
 const workspace:SuperWorkspace={active:true,project:{projectId:'p',routerSessionId:'pilot',version:1},channels:[{id:'c',projectId:'p',roleId:'db',roleName:'数据库专员',sessionId:'channel',revision:1,createdAt:'',execution:{kind:'native'}}],workers:[{id:'w',roleId:'db',roleName:'数据库专员',sessionId:'task-session',assignmentState:'parked',execution:{backend:{kind:'acp',agent:'codex'},source:'task_assignment',assignedAt:'',runs:[],totalRuns:0},task:{taskId:'t',sessionId:'task-session',title:'迁移',state:'completed',acceptanceState:'not_evaluated',revision:1,originRootTurnId:'root',deadlineAt:''}}]};
 const html=renderToStaticMarkup(createElement(PilotWorkspace,{workspace,error:'',selectedId:'pilot',onPilot(){},onWorker(){}}));
 assert.match(html,/<strong>数据库专员<\/strong>/);assert.match(html,/Agent 类型：Lake/);
 assert.doesNotMatch(html,/Agent 类型：Codex/);assert.match(html,/super-role-avatar/);
 workspace.channels![0].execution={kind:'acp',agent:'codex'};
 const updated=renderToStaticMarkup(createElement(PilotWorkspace,{workspace,error:'',selectedId:'pilot',onPilot(){},onWorker(){}}));
 assert.match(updated,/Agent 类型：Codex/);assert.match(updated,/providers\/openai.svg/);
});

test('report logos retain the original execution and never inherit a current conversation Agent',()=>{
 const author:SpecialistReplyAuthor={kind:'specialist',name:'数据库专员',roleId:'db',workerId:'w',sessionId:'s',taskId:'t',execution:{kind:'native'}};
 const identity={name:'Pilot',pilot:true,execution:{kind:'acp' as const,agent:'codex' as const}};
 const html=renderToStaticMarkup(createElement(ReplyIdentity,{author,identity,onSpecialist(){}}));
 assert.match(html,/aria-label="与数据库专员继续沟通 · Agent 类型：Lake"/);
 assert.match(html,/<strong>数据库专员<\/strong>/);assert.match(html,/Agent 类型：Lake/);
 assert.doesNotMatch(html,/Agent 类型：Codex/);assert.match(html,/response-avatar/);
 delete author.execution;
 assert.doesNotMatch(renderToStaticMarkup(createElement(ReplyIdentity,{author,identity})),/agent-backend-logo/);
 assert.doesNotMatch(renderToStaticMarkup(createElement(ReplyIdentity,{identity})),/agent-backend-logo/);
 author.execution={kind:'acp',agent:'codex'};
 assert.match(renderToStaticMarkup(createElement(ReplyIdentity,{author,identity})),/providers\/openai.svg/);
});
