import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Resource,SessionSnapshot} from '../../shared/contracts';
import type {TranscriptEntry} from '../src/timeline';
import {conversationGroups} from '../src/conversation-progress-model';
import {resourceStageProgress} from '../src/resourceStageProgress';
import {AITranscript} from '../src/AIPanel';
const at='2026-10-21T01:00:00Z';
const resources=[{id:'host-a',name:'192.168.2.141',kind:'ssh'},{id:'host-b',name:'演示数据库',kind:'database'}] as Resource[];
const tool=(id:string,resource=resources[0]!):TranscriptEntry=>({id,at,card:{id,at,type:'operation',title:'shell',status:'completed',data:{resource_id:resource.id,target:resource.name}}});
const say=(id:string,content:string):TranscriptEntry=>({id,at,card:{id,at,type:'message',status:'completed',content}});
const project=(entries:TranscriptEntry[],live=true,completed=false)=>resourceStageProgress(entries,conversationGroups(entries,resources),live,completed);
test('resource stages append history but use one latest slot per resource',()=>{
 const entries=[tool('a'),say('export','导出完成，用时 3.5 秒。'),tool('b',resources[1]),say('restore','恢复完成，用时 13.6 秒。'),tool('check'),say('verified','一致性校对通过。')];
 const result=project(entries);
 assert.deepEqual(result.byResource.get('a')!.map(entry=>entry.id),['export','verified']);
 assert.deepEqual(result.byResource.get('b')!.map(entry=>entry.id),['restore']);
 assert.equal(result.overall.length,0);
 assert.equal(result.ids.size,3);
 assert.equal(entries.length,6,'projection never rewrites stored transcript');
});
test('explicit IDs and exact resource names can attribute prose after mixed tool batches',()=>{
 const mixed=[tool('a'),tool('b',resources[1])];
 assert.deepEqual(project([...mixed,say('exact','演示数据库恢复完成。')]).byResource.get('b')!.map(entry=>entry.id),['exact']);
 const explicit=say('explicit','本轮恢复已完成。');explicit.card!.data={resource_id:'host-b'};
 assert.equal(project([...mixed,explicit]).byResource.get('b')!.at(-1)!.id,'explicit');
 const wrong=say('wrong','结果完成。');wrong.card!.data={resource_id:'foreign'};
 assert.equal(project([tool('a'),wrong]).overall[0]!.id,'wrong');
});
test('joint and ambiguous stages feed synthesis once rather than cloning resource previews',()=>{
 const mixed=[tool('a'),tool('b',resources[1])];
 const result=project([...mixed,say('cross','192.168.2.141 到演示数据库的传输完成。'),say('next','联合检查完成。')]);
 assert.equal(result.byResource.size,0);
 assert.deepEqual(result.overall.map(entry=>entry.id),['cross','next']);
 assert.equal(project([...mixed,say('prefix','192.168.2.1419 状态未知。')]).byResource.size,0,'partial IP cannot invent an owner');
});
test('resource context is retained between consecutive stages but reset by generic operations',()=>{
 assert.equal(project([tool('a'),say('one','正在恢复。'),say('two','恢复完成。')]).byResource.get('a')!.length,2);
 const generic=tool('generic');generic.card!.data={target:'当前项目/会话'};
 const result=project([tool('a'),say('one','正在恢复。'),generic,say('two','其他进展。')]);
 assert.equal(result.byResource.get('a')!.length,1);
 assert.equal(result.overall[0]!.id,'two');
});
test('real final replies stay in prose; incomplete, stopped, plain and role reports keep their presentation',()=>{
 const entries=[tool('a'),say('stage','阶段一完成。'),tool('b',resources[1]),say('final','最终总结：全部完成。')];
 const result=project(entries,false,true);
 assert.ok(result.ids.has('stage')&&!result.ids.has('final'));
 assert.equal(project(entries,false,false).ids.size,0);
 assert.equal(project([say('plain','普通回复')]).ids.size,0);
 assert.equal(project([tool('a')],false,true).ids.size,0);
 assert.equal(project([...entries,{id:'agent',at,agentRun:{id:'role'}} as TranscriptEntry]).ids.size,0);
});
test('visible preview is under its resource even when actions are folded; previous stages are lazy',()=>{
 const entries=[tool('a'),say('old-stage','第一阶段结果'),tool('a2'),say('latest-stage','最新阶段结果')];
 const snapshot={session:{id:'s'},messages:[{id:'u',sessionId:'s',role:'user',text:'检查',createdAt:at}],actions:[],resources,ai:{session:'s',status:'running',cardsOffset:0,cards:entries.map(entry=>entry.card!)}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
 assert.ok(html.includes('data-stage-entry="latest-stage"'));
 assert.ok(!html.includes('data-stage-entry="old-stage"'));
 assert.ok(html.includes('此前进展 · 1'));
 assert.ok(!html.includes('thinking-steps'));
 assert.ok(html.indexOf('data-stage-entry="latest-stage"')<html.indexOf('class="turn-execution-body"')+html.slice(html.indexOf('class="turn-execution-body"')).indexOf('</section>'));
 assert.ok(html.includes('class="settled-reply is-archived"'),'original prose stays mounted but hidden');
});


test('an ambiguous source/target paragraph is not copied beneath each involved resource',()=>{
 const result=project([tool('a'),tool('b',resources[1]),say('result','传完并放好了。现在清掉目标端上一次恢复的库，再全量重建。')]);
 assert.equal(result.byResource.size,0);
 assert.deepEqual(result.overall.map(entry=>entry.id),['result']);
});
test('repeated prose with different IDs and formatting has only one projected owner',()=>{
 const body='目标端只保留 postgres 系统库，开始全量重建。';
 const result=project([tool('a'),say('one',body),tool('b',resources[1]),say('two',body.replace('postgres','`postgres`'))]);
 assert.equal(result.byResource.size,0,'conflicting owners must not duplicate or invent ownership');
 assert.deepEqual(result.overall.map(entry=>entry.id),['two']);
 assert.ok(result.ids.has('one')&&result.ids.has('two'),'both originals remain in archived process history');
 const same=project([tool('a'),say('one',body),say('two',body)]);
 assert.deepEqual(same.byResource.get('a')!.map(entry=>entry.id),['two']);
});
test('same entry replay and a third duplicate cannot restore a conflicting owner',()=>{
 const repeated=say('same','阶段检查已经完成，正在准备恢复。');
 const result=project([tool('a'),repeated,repeated,tool('b',resources[1]),{...repeated,id:'other',card:{...repeated.card!,id:'other'}},tool('a2'),say('third',repeated.card!.content!)]);
 assert.equal(result.byResource.size,0);
 assert.equal(result.overall.length,1);
});
test('overall narration uses one slot below the divider, never an overall card inside execution',()=>{
 const generic=tool('generic');generic.card!.data={target:'当前项目/会话'};
 const entries=[say('plan','先看源库与目标端。'),tool('a'),tool('b',resources[1]),say('result','源库连接正常，目标端还没有镜像。'),generic,say('overall','现在准备后续整体步骤。')];
 const snapshot={session:{id:'s'},messages:[{id:'u',sessionId:'s',role:'user',text:'检查',createdAt:at}],actions:[],resources,ai:{session:'s',status:'running',cardsOffset:0,cards:entries.map(entry=>entry.card!)}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
 assert.ok(!html.includes('整体进展'));
 assert.equal((html.match(/data-stage-entry="result"/g)??[]).length,0);
 assert.equal((html.match(/class="resource-stage-summary is-overall"/g)??[]).length,1);
 const overall=html.indexOf('class="resource-stage-summary is-overall"');
 assert.ok(overall>html.lastIndexOf('</section>'));
 assert.ok(!html.slice(overall).includes('data-stage-entry="overall"'));
 assert.ok(!html.slice(overall).includes("现在准备后续整体步骤"));
 assert.ok(!html.slice(overall).includes("最新阶段："));
 assert.ok(!html.slice(overall).includes('data-stage-entry="plan"'),'overall preview replaces earlier narration');
});
