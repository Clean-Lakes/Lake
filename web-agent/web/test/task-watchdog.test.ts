import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {WatchdogSettings} from '../src/WatchdogSettings';
import {TaskWatchdog} from '../src/TaskWatchdog';
import {api} from '../src/api';
import type {WatchdogFinding} from '../../shared/contracts';

const observations: WatchdogFinding[] = [
  {id:'one', at:'2026-11-07T12:00:00Z', kind:'drift', reason:'正在检查任务范围外的目录', evidence:['目标是乙目录'], action:'observed'},
  {id:'two', at:'2026-11-07T12:15:00Z', kind:'drift', reason:'仍在读取甲目录', evidence:['乙专员的两次读取都指向甲目录'], action:'guided'},
];
const render = (findings: WatchdogFinding[]) => renderToStaticMarkup(createElement(TaskWatchdog, {
  view:{mode:'observe',findings},
}));

test('watchdog shows the latest intervention and its evidence; queueing guidance does not imply recovery', () => {
  const html = render(observations);
  assert.match(html, /已排队纠偏/);
  assert.match(html, /乙专员的两次读取都指向甲目录/);
  assert.doesNotMatch(html, /已观察到新进展/);
  const progress = render([{...observations[1], kind:'uncertain', verdict:'progress', action:'observed'}]);
  assert.match(progress, /正在推进/);
  assert.doesNotMatch(progress, /待核实/);
  assert.ok(html.indexOf('仍在读取甲目录') < html.indexOf('更早的 1 条记录'));
  assert.ok(html.indexOf('更早的 1 条记录') < html.indexOf('正在检查任务范围外的目录'));
  assert.equal(render([]),'');
  assert.doesNotMatch(render([]), /本次执行的巡检记录|巡检依据/);
  assert.doesNotMatch(html,/combobox|项目巡检模式/);
});

test('watchdog mode is an explicit project setting, separate from task controls', async t => {
  const requests: Array<{path:string; method?:string; body:unknown}> = [];
  t.mock.method(globalThis,'fetch',async (url:string,init?:RequestInit)=>{
    requests.push({path:url,method:init?.method,body:JSON.parse(String(init?.body))});
    return Response.json({mode:'guide'});
  });
  assert.deepEqual(await api.setWatchdogMode('项目/乙','guide'),{mode:'guide'});
  assert.deepEqual(requests,[{path:'/api/projects/'+encodeURIComponent('项目/乙')+'/watchdog',method:'PUT',body:{mode:'guide'}}]);
});


test('watchdog configuration is centralized in settings, reads existing project state and never assumes a mode while loading',()=>{
 const props={projectId:'project-b',projectName:'乙项目'};
 const html=renderToStaticMarkup(createElement(WatchdogSettings,props));
 assert.match(html,/id="watchdog-settings-panel"/);assert.match(html,/乙项目/);
 assert.match(html,/统一应用于本项目的专员任务/);assert.match(html,/读取中/);assert.match(html,/role="combobox"[^>]*disabled/);
 assert.match(renderToStaticMarkup(createElement(WatchdogSettings,{})),/请先选择一个项目/);
});

test('watchdog settings read the exact project without mutating its mode',async t=>{
 const requests:Array<{path:string;method?:string}> = [];
 t.mock.method(globalThis,'fetch',async(url:string,init?:RequestInit)=>{requests.push({path:url,method:init?.method});return Response.json({mode:'off'});});
 assert.deepEqual(await api.watchdogMode('项目/乙'),{mode:'off'});
 assert.deepEqual(requests,[{path:'/api/projects/'+encodeURIComponent('项目/乙')+'/watchdog',method:undefined}]);
});
