import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ProposedPlan,SessionSnapshot,WorkSession} from '../../shared/contracts';
import {PlanCatalog,SessionPlansPage} from '../src/PlanList';
import {readWorkspaceRoute,workspaceURL} from '../src/workspaceRoute';

test('session plan pages have a durable URL while conversation and resource links clear the page view',()=>{
 const plans=workspaceURL('http://localhost:4177/?session=previous&resource=host&view=ignored&keep=1',{sessionId:'target / 会话',resourceId:null,view:'plans'});
 assert.deepEqual(readWorkspaceRoute(plans.search),{sessionId:'target / 会话',resourceId:null,view:'plans'});
 assert.equal(plans.searchParams.get('keep'),'1');
 const conversation=workspaceURL(plans.href,{sessionId:'target / 会话',resourceId:null});
 assert.equal(conversation.searchParams.has('view'),false);
 const resource=workspaceURL(plans.href,{sessionId:'target / 会话',resourceId:'host'});
 assert.equal(resource.searchParams.has('view'),false);assert.equal(resource.searchParams.get('resource'),'host');
 assert.deepEqual(readWorkspaceRoute('?session=s&view=unsupported'),{sessionId:'s',resourceId:null});
 assert.deepEqual(readWorkspaceRoute('?view=plans'),{sessionId:null,resourceId:null});
 assert.deepEqual(readWorkspaceRoute('?session=s&resource=r&view=plans'),{sessionId:'s',resourceId:'r'});
});

const session={id:'target',title:'迁移完整性核对',projectId:'project',status:'completed'} as WorkSession;
const handlers={disabled:false,onBack:()=>{},onRetry:()=>{},onRevise:()=>{},onExecuted:async()=>{}};
test('dedicated plan page identifies its session and offers return navigation without a composer',()=>{
 const snapshot={session,resources:[],messages:[],actions:[]} as unknown as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(SessionPlansPage,{...handlers,session,snapshot}));
 assert.match(html,/会话计划：迁移完整性核对/);assert.match(html,/<h1[^>]*>会话计划/);assert.match(html,/返回对话/);assert.match(html,/计划列表/);
 assert.doesNotMatch(html,/message-input|composer-dock|<form|发送消息/);
});

test('opening another session never renders the previous session snapshot',()=>{
 const previous={session:{id:'other'},ai:{cards:[{content:'OTHER_SESSION_PRIVATE_PLAN'}]}} as unknown as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(SessionPlansPage,{...handlers,session,snapshot:previous}));
 assert.match(html,/正在加载会话计划/);assert.doesNotMatch(html,/OTHER_SESSION_PRIVATE_PLAN|计划列表/);
 const failed=renderToStaticMarkup(createElement(SessionPlansPage,{...handlers,session,snapshot:null,error:'暂时无法连接'}));
 assert.match(failed,/计划未能加载/);assert.match(failed,/重新加载/);assert.match(failed,/返回对话/);
});

test('plan catalog shows every saved title and status without rendering plan bodies',()=>{
 const plans=[{id:'latest',at:'2026-10-22T08:00:00Z',content:'# 数据迁移验证\n\nPRIVATE_PLAN_BODY_LATEST'},{id:'older',at:'2026-10-21T08:00:00Z',content:'# 迁移准备\n\nPRIVATE_PLAN_BODY_OLDER'}] as ProposedPlan[];
 const html=renderToStaticMarkup(createElement(PlanCatalog,{plans,pendingId:'latest',onOpen:()=>{}}));
 assert.match(html,/<ul[^>]*aria-label="已保存的计划"/);
 assert.equal((html.match(/<li>/g)||[]).length,2);
 assert.match(html,/数据迁移验证/);assert.match(html,/迁移准备/);assert.match(html,/待确认/);assert.match(html,/历史计划/);assert.match(html,/查看详情/);
 assert.doesNotMatch(html,/PRIVATE_PLAN_BODY|assistant-markdown|<details|<article/);
 assert.ok(html.indexOf('数据迁移验证')<html.indexOf('迁移准备'));
});
