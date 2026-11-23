import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Catalog,Project} from '../../shared/contracts';
import {WorkspacePage,WorkspaceProjectList} from '../src/WorkspacePage';
import {initialWorkspaceSelection} from '../src/sidebarState';
import {readWorkspaceRoute,workspaceURL} from '../src/workspaceRoute';

const project:Project={id:'p',name:'测试项目',createdAt:'2026-11-23T01:00:00Z'};
const noop=()=>{};
const actions={onOpenNavigation:noop,onCreateProject:noop,onDeleteProject:noop,onToggleBulk:noop,onSettings:noop,onUpdates:noop,onTrash:noop};

test('workspace is a direct route with or without conversation and resource context',()=>{
 for(const route of [
  {sessionId:null,resourceId:null,view:'workspace' as const},
  {sessionId:'s',resourceId:'r',view:'workspace' as const},
 ]){
  const url=workspaceURL('http://localhost/?keep=1&view=plans',route);
  assert.deepEqual(readWorkspaceRoute(url.search),route);
  assert.equal(url.searchParams.get('keep'),'1');
  assert.equal(workspaceURL(url.href,{sessionId:route.sessionId,resourceId:route.resourceId}).searchParams.has('view'),false);
 }
});

test('startup restores the workspace page for empty projects and preserves an owned resource',()=>{
 const route={sessionId:null,resourceId:null,view:'workspace' as const};
 assert.deepEqual(initialWorkspaceSelection({projects:[],sessions:[],resources:[]},route),{projectId:null,route});
 const catalog={projects:[project],sessions:[{id:'s',projectId:project.id,workspaceRole:'router'}],resources:[{id:'r',projectId:project.id}]} as Catalog;
 assert.deepEqual(initialWorkspaceSelection(catalog,{...route,resourceId:'r'}),{
  projectId:project.id,route:{sessionId:'s',resourceId:'r',view:'workspace'},
 });
});

test('workspace actions render in the page, including a creation path for an empty workspace',()=>{
 const props={connected:true,bulkMode:false,modelConfigured:true,unreadUpdate:false,...actions};
 const html=renderToStaticMarkup(createElement(WorkspacePage,{...props,project}));
 for(const label of ['工作区','当前项目',project.name,'新建项目','批量管理','删除项目','设置','检查更新','已删除'])assert.ok(html.includes(label),label);
 assert.match(html,/id="workspace-page"/);
 assert.doesNotMatch(html,/role="dialog"|composer-dock|message-input/);
 const empty=renderToStaticMarkup(createElement(WorkspacePage,props));
 assert.match(empty,/暂无项目[\s\S]*新建项目/);
 assert.doesNotMatch(empty,/删除项目|批量管理/);
});

test('the workspace project list exposes exactly one current project',()=>{
 const html=renderToStaticMarkup(createElement(WorkspaceProjectList,{projects:[project,{...project,id:'other',name:'其他项目'}],projectId:project.id,onSelect:noop}));
 assert.equal((html.match(/aria-current="true"/g)??[]).length,1);
 assert.match(html,/aria-current="true" title="测试项目"/);
 assert.match(html,/其他项目/);
});
