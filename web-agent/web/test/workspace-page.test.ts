import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Catalog,Project} from '../../shared/contracts';
import {WorkspacePage} from '../src/WorkspacePage';
import {initialWorkspaceSelection} from '../src/sidebarState';
import {readWorkspaceRoute,workspaceURL} from '../src/workspaceRoute';
import {consoleCategories} from '../src/workspaceConsoleTabs';

const css=registerHooks({load(url,context,nextLoad){return url.endsWith('.css')?{format:'module',source:'export {};',shortCircuit:true}:nextLoad(url,context)}});
const {SidebarWorkspaceNavigation}=await import('../src/SidebarWorkspaceNavigation');
css.deregister();

const project:Project={id:'p',name:'测试项目',createdAt:'2026-11-23T01:00:00Z'};
const noop=()=>{};
const props={connected:true, projects:[project], resources:[{projectId:project.id}], bulkSelectedCount:0,
 onClose:noop, onOpenProject:noop, onCreateProject:noop, onDeleteProject:noop,
 onToggleBulk:noop, onClearSelection:noop, onDeleteSelected:noop};

const workspaceViews=['workspace','settings','updates'] as const;

test('each workspace page is a direct route with or without conversation and resource context',()=>{
 for(const view of workspaceViews) for(const context of [
  {sessionId:null,resourceId:null},
  {sessionId:'s',resourceId:'r'},
 ]){
  const route={...context,view};
  const url=workspaceURL('http://localhost/?keep=1&view=plans',route);
  assert.deepEqual(readWorkspaceRoute(url.search),route);
  assert.equal(url.searchParams.get('keep'),'1');
  assert.equal(workspaceURL(url.href,{sessionId:route.sessionId,resourceId:route.resourceId}).searchParams.has('view'),false);
 }
});

test('startup restores the workspace page for empty projects and preserves an owned resource',()=>{
 const catalog={projects:[project],sessions:[{id:'s',projectId:project.id,workspaceRole:'router'}],resources:[{id:'r',projectId:project.id}]} as Catalog;
 for(const view of workspaceViews){
  const route={sessionId:null,resourceId:null,view};
  assert.deepEqual(initialWorkspaceSelection({projects:[],sessions:[],resources:[]},route),{projectId:null,route});
  assert.deepEqual(initialWorkspaceSelection(catalog,{...route,resourceId:'r'}),{
   projectId:project.id,route:{sessionId:'s',resourceId:'r',view},
  });
 }
});

test('a console opened over a plan keeps its plan context only for a valid session',()=>{
 const route={sessionId:'s',resourceId:null,view:'settings',returnView:'plans'} as const;
 const session={id:'s',projectId:project.id,workspaceRole:'router'};
 const catalog={projects:[project],sessions:[session],resources:[]} as Catalog;
 assert.deepEqual(readWorkspaceRoute(workspaceURL('http://localhost/',route).search),route);
 assert.deepEqual(initialWorkspaceSelection(catalog,route).route,route);
 assert.equal(initialWorkspaceSelection({...catalog,sessions:[]},route).route.returnView,undefined);
 assert.equal(readWorkspaceRoute('?view=settings&session=s&resource=r&returnView=plans').returnView,undefined);
});

test('console category search matches labels and keywords without exposing TypeScript-only settings on Go',()=>{
 assert.deepEqual(consoleCategories(true,'客户端 mcp').flatMap(group=>group.items.map(item=>item.key)),['channels']);
 assert.deepEqual(consoleCategories(false,'客户端 mcp'),[]);
 assert.deepEqual(consoleCategories(true,'默认模型').flatMap(group=>group.items.map(item=>item.key)),['models']);
});

test('workspace actions render in the page, including a creation path for an empty workspace',()=>{
 const html=renderToStaticMarkup(createElement(WorkspacePage,{...props,project}));
 for(const label of ['当前项目',project.name,'新建项目','批量管理','删除项目','打开当前项目','搜索项目'])assert.ok(html.includes(label),label);
 assert.match(html,/id="workspace-page"/);
 assert.match(html,/<h1 id="workspace-page-title"[^>]*>项目<\/h1>/);
 assert.match(html,/<header[\s\S]*新建项目[\s\S]*关闭控制台[\s\S]*<\/header>[\s\S]*搜索项目[\s\S]*批量管理/);
 assert.equal((html.match(/type="search"/g)??[]).length,1);
 assert.doesNotMatch(html,/role="dialog"|composer-dock|message-input|检查更新|已删除|搜索会话和资源|进入项目/);
 const empty=renderToStaticMarkup(createElement(WorkspacePage,{...props,projects:[]}));
 assert.match(empty,/新建项目[\s\S]*暂无项目/);
 assert.doesNotMatch(empty,/删除项目|批量管理|搜索项目/);
});

test('the rail opens the console dialog and signals unread updates',()=>{
 const sidebar=renderToStaticMarkup(createElement(SidebarWorkspaceNavigation,{
  projectId:project.id, specialists:null, children:null, resourceCount:0, selectionId:project.id, selectedPanel:'specialists',
  workspace:{open:false, unreadUpdate:true, onOpen:noop},
 }));
 assert.match(sidebar,/aria-label="控制台，有新版本" aria-haspopup="dialog" aria-expanded="false" aria-controls="workspace-console"/);
 assert.doesNotMatch(sidebar,/role="menu(?:item)?"|设置|检查更新|已删除/);
});

test('each project can open directly and the bulk mode uses checkboxes instead',()=>{
 const page={...props, project, projects:[project,{...project,id:'other',name:'其他项目'}]};
 const navigation=renderToStaticMarkup(createElement(WorkspacePage,page));
 assert.equal((navigation.match(/<button type="button" class="workspace-project-row"/g)??[]).length,2);
 assert.match(navigation,/打开当前项目 /);
 assert.match(navigation,/切换到 /);
 const html=renderToStaticMarkup(createElement(WorkspacePage,{
  ...page,
  bulkSelection:{has:target=>target.id===project.id, toggle:noop, disabled:false}, bulkSelectedCount:1,
 }));
 assert.equal((html.match(/aria-current="true"/g)??[]).length,1);
 assert.match(html,/aria-current="true" title="测试项目"/);
 assert.match(html,/aria-label="选择项目 测试项目" checked=""/);
 assert.match(html,/aria-label="选择项目 其他项目"/);
 assert.doesNotMatch(html,/<button type="button" class="workspace-project-row"/);
 assert.match(html,/已选 1 项/);
 assert.match(html,/class="workspace-project-resource-count">1/);
});
