import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {InspectorExecutionSteps} from '../src/InspectorExecutionSteps';
import {InspectorTaskSummary} from '../src/InspectorTaskSummary';
import {islandFixture} from './fixtures/pilot-island-data';

test('execution view groups actual completed steps without losing pending steps',()=>{
 const snapshot=islandFixture(),task=snapshot.sre!.tasks[0]!;
 const html=renderToStaticMarkup(createElement(InspectorExecutionSteps,{task,resources:snapshot.resources,onSelect(){}}));
 assert.ok(html.includes('已完成 · 3 项'));
 assert.ok(html.includes('核对日志与错误来源')&&html.includes('检查磁盘占用'));
 assert.ok(html.includes('data-state="running"'));
 assert.ok(html.includes('<details class="execution-completed">'),'completed group is initially collapsed');
 assert.ok(!html.includes('恢复已验证'));
});

test('a revised plan cannot expose old attempts as clickable current steps',()=>{
 const snapshot=islandFixture(),task=snapshot.sre!.tasks[0]!;
 task.plans.push({...task.plans[0]!,id:'new-plan',version:2});
 const html=renderToStaticMarkup(createElement(InspectorExecutionSteps,{task,resources:snapshot.resources,onSelect(){}}));
 assert.ok(!html.includes('data-selected="true"'));
 assert.equal((html.match(/<button type="button" disabled=""/g)??[]).length,task.plans.at(-1)!.steps.length);
});

test('paused execution does not display stale running steps; uncertainty stays visible',()=>{
 const snapshot=islandFixture('paused'),task=snapshot.sre!.tasks[0]!;
 const html=renderToStaticMarkup(createElement(InspectorExecutionSteps,{task,resources:snapshot.resources,onSelect(){}}));
 assert.ok(!html.includes('data-state="running"'));
 const finished=islandFixture('finished').sre!.tasks[0]!;
 const outcome=renderToStaticMarkup(createElement(InspectorTaskSummary,{task:finished,title:'检查',compact:true}));
 assert.ok(outcome.includes('结论不充分'));
 assert.ok(!outcome.includes('progressbar')&&!outcome.includes('恢复已验证'));
});
