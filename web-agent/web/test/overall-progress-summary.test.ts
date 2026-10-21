import test from 'node:test';
import assert from 'node:assert/strict';
import type {AIView,Resource} from '../../shared/contracts';
import type {TranscriptEntry} from '../src/timeline';
import {conversationGroups} from '../src/conversation-progress-model';
import {resourceStageProgress} from '../src/resourceStageProgress';
import {overallProgressSummary} from '../src/overall-progress-model';
const at='2026-10-21T01:00:00Z';
const resources=[{id:'source',name:'演示源库',kind:'database'},{id:'target',name:'演示目标库',kind:'database'}] as Resource[];
const tool=(id:string,ref='source',status='completed'):TranscriptEntry=>({id,at,card:{id,at,type:'operation',title:'execute_sql',status,data:{resource_id:ref,target:resources.find(r=>r.id===ref)!.name}}});
const text=(id:string,content:string):TranscriptEntry=>({id,at,card:{id,at,type:'message',status:'completed',content}});
const summarize=(turn:TranscriptEntry[],view?:AIView)=>{const groups=conversationGroups(turn,resources);return overallProgressSummary(turn,groups,resourceStageProgress(turn,groups,true,false),view)!;};
test('new resource stages replace the initial plan in overall progress without global narration',()=>{
 const entries=[text('plan','先确认当前状态。'),tool('export'),text('exported','导出完成：26 个库，46.3 秒。'),tool('restore','target','running')];
 const summary=summarize(entries);
 assert.equal(summary.latest!.id,'exported');
 assert.ok(summary.facts.includes('2 个资源')&&summary.facts.includes('已完成 1 项操作'));
 assert.ok(summary.activity.includes('演示目标库'));
 assert.ok(!summary.activity.includes('先确认'));
 const next=summarize([...entries,text('restoring','26 个 dump 已就位，正在恢复。')]);
 assert.equal(next.latest!.id,'restoring');
});
test('tool status updates refresh overall counts even without another prose message',()=>{
 const running=tool('restore','target','running');
 const before=summarize([tool('export'),running]);
 const after=summarize([tool('export'),{...running,card:{...running.card!,status:'completed'}}]);
 assert.ok(before.facts.includes('已完成 1 项操作'));
 assert.ok(after.facts.includes('已完成 2 项操作'));
 assert.ok(before.activity.includes('正在执行 SQL'));
 assert.ok(!after.activity.includes('当前正在执行 SQL'));
 assert.equal(before.latest,undefined,'no synthetic stage result');
});
test('joint results and duplicate entries never double count completed operations',()=>{
 const first=tool('a'),second=tool('b','target');
 const summary=summarize([first,first,second,text('joint','两端检查已返回。')]);
 assert.ok(summary.facts.includes('已完成 2 项操作'));
 assert.equal(summary.latest!.id,'joint');
});
test('pending questions, unknown outcomes, failures and background work stay honest',()=>{
 assert.equal(summarize([tool('a','source','pending')]).activity,'等待确认后继续。');
 assert.equal(summarize([tool('a')],{question:{id:'q'},status:'running'} as AIView).activity,'等待你的选择。');
 for(const [status,label] of [['failed','失败'],['unknown','结果待核查'],['not_executed','未执行'],['background_running','后台执行中'],['cancelled','已停止'],['interrupted','已停止']]){
  const summary=summarize([tool('a','source',status)]);
  assert.ok(summary.facts.includes('已完成 0 项操作')&&summary.facts.includes(label));
 }
});
test('plain answers and previous turns cannot invent resource progress',()=>{
 assert.equal(overallProgressSummary([text('reply','普通回答')],[],{ids:new Set(),byResource:new Map(),overall:[]}),undefined);
 const summary=summarize([tool('new','target')]);
 assert.ok(summary.facts.includes('1 个资源')&&summary.facts.includes('1 项操作'));
});
