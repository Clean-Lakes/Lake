import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ScheduledTask} from '../../shared/contracts';
import {ScheduleHistory} from '../src/ScheduleHistory';
import {scheduleFrequency,scheduleNext,scheduleEnabledLabel,scheduleStatus} from '../src/scheduledTaskPresentation';
const task={id:'s',project_id:'p',session_id:'original',name:'Fixture',kind:'workflow',enabled:false,status:'running',revision:3,at:'2026-10-20T10:00:00+08:00',interval_seconds:600,history_count:2} as ScheduledTask;
test('pause and execution states stay independent; completed one-off is not called paused',()=>{
 assert.equal(scheduleNext(task),'后续已暂停，本次继续执行');
 assert.equal(scheduleEnabledLabel(task),'已暂停');
 assert.equal(scheduleNext({...task,status:'completed',interval_seconds:0}),'已结束');
 assert.equal(scheduleEnabledLabel({...task,status:'completed',interval_seconds:0}),'已结束');
 assert.equal(scheduleStatus('unknown'),'状态待核查');
 assert.equal(scheduleFrequency(0),'单次');assert.equal(scheduleFrequency(600),'每 10 分钟');assert.equal(scheduleFrequency(3600),'每 1 小时');
});
test('history renders actual recorded outcomes newest first without invented completions',()=>{
 const html=renderToStaticMarkup(createElement(ScheduleHistory,{task:{...task,history:[{id:'old',scheduled_at:task.at,status:'completed',finished_at:task.at,session_id:'old-session'},{id:'new',scheduled_at:task.at,status:'failed',error:'Fixture failure',session_id:'new-session'}]},onOpenSession:()=>{}}));
 assert.ok(html.indexOf('失败')<html.indexOf('已完成'));
 assert.ok(html.includes('Fixture failure')&&html.includes('查看会话与结果'));
 const unknown=renderToStaticMarkup(createElement(ScheduleHistory,{task:{...task,history:[{id:'x',scheduled_at:task.at,status:'unknown'}]},onOpenSession:()=>{}}));
 assert.ok(unknown.includes('状态待核查')&&!unknown.includes('已完成'));
 const legacy=renderToStaticMarkup(createElement(ScheduleHistory,{task:{...task,last_at:task.at,history:[]},onOpenSession:()=>{}}));
 assert.ok(legacy.includes('旧版仅保留最近状态')&&!legacy.includes('<ol>'));
});
