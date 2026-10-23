import {composerMessage,composerToken,type ComposerReference} from '../src/composerMentionState';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PlanModeToggle,PlanActions,planSlashCommand,planMarkdown,planComposerDraft} from '../src/PlanMode';

test('Plan command supports toggle and inline prompts without matching other commands',()=>{
 assert.deepEqual(planSlashCommand('/plan'),{prompt:''});
 assert.deepEqual(planSlashCommand(' /plan  调查架构\n并生成方案 '),{prompt:'调查架构\n并生成方案'});
 for(const text of ['/planet','请用 /plan','/planfoo','/plan-now']) assert.equal(planSlashCommand(text),null);
});

test('Plan toggle exposes persistent selected and disabled states',()=>{
 const render=(mode:'plan'|'default',disabled=false)=>renderToStaticMarkup(createElement(PlanModeToggle,{mode,disabled,onChange:async()=>{}}));
 assert.match(render('plan'),/aria-pressed="true"/);
 assert.match(render('plan'),/只读调查/);
 assert.match(render('default'),/aria-pressed="false"/);
 assert.match(render('default',true),/disabled=""/);
 assert.match(render('default',true),/待发送消息/);
});

test('Reviewed plan presents explicit execute and revise actions, both unavailable while blocked',()=>{
 const html=renderToStaticMarkup(createElement(PlanActions,{disabled:true,onExecute:async()=>{},onRevise:()=>{}}));
 assert.match(html,/aria-label="计划操作"/);
 assert.match(html,/修改计划/);assert.match(html,/执行计划/);
 assert.equal((html.match(/disabled=""/g)??[]).length,2);
});

 test('Plan protocol tags stay hidden while Markdown remains complete',()=>{
  assert.equal(planMarkdown('<proposed_plan>\n# 计划\n\n1. 验证\n</proposed_plan>'),'# 计划\n\n1. 验证');
  assert.equal(planMarkdown('<proposed_plan>\n# 正在规划'),'# 正在规划');
  assert.equal(planMarkdown('普通回复'),'普通回复');
  assert.equal(planMarkdown('已确认范围。\n\n<proposed_plan>\n# 计划\n\n1. 验证\n</proposed_plan>\n请审阅。'),'已确认范围。\n\n# 计划\n\n1. 验证\n请审阅。');
  const example='协议示例：\n```xml\n<proposed_plan>\n示例\n</proposed_plan>\n```';
  assert.equal(planMarkdown(example),example);
 });

test('inline Plan commands preserve atomic resource and skill references after removing the prefix',()=>{
 const draft=`/plan 检查 ${composerToken} 并参考 ${composerToken}`;
 const references:ComposerReference[]=[{kind:'resource',resourceId:'host',label:'@Local machine',position:draft.indexOf(composerToken)},{kind:'skill',resourceId:'review',label:'@review',position:draft.lastIndexOf(composerToken)}];
 const prepared=planComposerDraft(draft,references);
 const payload=composerMessage(prepared.text,prepared.references,['host']);
 assert.equal(payload.text,'检查 @Local machine 并参考 @review');
 assert.deepEqual(payload.resourceIds,['host']);
 for(const mention of payload.mentions)assert.equal(payload.text.slice(mention.start,mention.end),mention.label);
 assert.equal(references[0]?.position,draft.indexOf(composerToken));
});
