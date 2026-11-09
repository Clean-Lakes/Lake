import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextUsage } from '../src/ContextUsage';
import type { AIView } from '../../shared/contracts';

const view = (context: AIView['context']): AIView => ({session:'usage-fixture',status:'completed',cards:[],turns:1,profile:'core',cardsOffset:0,totalCards:0,usage:{input:640000,output:442,total:640442,known:true},context});
test('context percentage uses measured input and configured allocation, not full provider capacity or total spend', () => {
 const html=renderToStaticMarkup(createElement(ContextUsage,{view:view({window:1000000,windowSource:'provider',budget:64000,used:30800,usedKnown:true,estimated:false,estimatedUsed:67800,lastRequest:{input:30800,output:442,total:31242,inputKnown:true,outputKnown:true,known:true}})}));
 assert.match(html,/上下文 48.1%/);
 assert.doesNotMatch(html,/上下文 3.1%|106%|64%/);
});
test('context never invents a percentage from default budget or missing usage', () => {
 for (const context of [
  {window:64000,used:67800,estimated:true},
  {window:1000000,windowSource:'provider',used:0,usedKnown:false,estimated:false},
  {window:64000,used:30000,usedKnown:true,estimated:false},
 ]) {
  assert.match(renderToStaticMarkup(createElement(ContextUsage,{view:view(context)})),/上下文 --/);
 }
});
test('reported zero is a valid measured percentage', () => {
 assert.match(renderToStaticMarkup(createElement(ContextUsage,{view:view({window:1000000,windowSource:'provider',used:0,usedKnown:true,estimated:false})})),/上下文 0.00%/);
});

test('switching the selected model does not show the preceding model percentage', () => {
 const html=renderToStaticMarkup(createElement(ContextUsage,{model:{modelId:'new-model'},view:view({modelId:'old-model',window:1000000,windowSource:'provider',used:30800,usedKnown:true,estimated:false})}));
 assert.match(html,/上下文 --/);
});

 test('output reservation is excluded from the input budget', () => {
  const html=renderToStaticMarkup(createElement(ContextUsage,{view:view({window:1000000,windowSource:'provider',budget:64000,inputBudget:55808,maxOutput:8192,used:73930,usedKnown:true,estimated:false})}));
  assert.match(html,/上下文 132.5%/); assert.doesNotMatch(html,/上下文 7.4%/);
 });
 test('known allocation can be used without inventing provider capacity', () => {
  const html=renderToStaticMarkup(createElement(ContextUsage,{view:view({window:0,budget:64000,inputBudget:55808,maxOutput:8192,used:27904,usedKnown:true,estimated:false})}));
  assert.match(html,/上下文 50.0%/);
 });

test('configured model capacity caps the displayed manual input budget', () => {
 const html=renderToStaticMarkup(createElement(ContextUsage,{view:view({window:8192,windowSource:'settings',budget:64000,inputBudget:60000,used:4096,usedKnown:true,estimated:false})}));
 assert.match(html,/上下文 50.0%/);
});


test('context follows the supplied current session status without replacing it with a budget color', () => {
 for(const status of ['idle','investigating','waiting_approval','completed','failed'] as const){
  const html=renderToStaticMarkup(createElement(ContextUsage,{status,view:view({window:100,budget:100,inputBudget:100,used:90,usedKnown:true,windowSource:'settings'})}));
  assert.match(html,new RegExp(`data-session-status="${status}"`));
  assert.match(html,/上下文 90.0%/);
  assert.match(html,/上下文输入预算接近或超过上限/);
  assert.doesNotMatch(html,/class="ai-context-fill near-limit/);
 }
});

test('quiet composer context stays hidden for ordinary, zero, unknown and stale-model usage',()=>{
 for(const context of [undefined,{window:100,windowSource:'settings',used:40,usedKnown:true},{window:100,windowSource:'settings',used:0,usedKnown:true},{window:100,windowSource:'settings',used:99,usedKnown:false}] as AIView['context'][])
  assert.equal(renderToStaticMarkup(createElement(ContextUsage,{view:view(context),presentation:'warning',compact:true})), '');
 assert.equal(renderToStaticMarkup(createElement(ContextUsage,{view:view({modelId:'old',window:100,windowSource:'settings',used:99,usedKnown:true}),model:{modelId:'current'},presentation:'warning'})), '');
});

test('quiet context warns at the measured input threshold and menu details remain discoverable',()=>{
 const sample=view({window:1000,windowSource:'settings',inputBudget:800,used:680,usedKnown:true});
 const warning=renderToStaticMarkup(createElement(ContextUsage,{view:sample,presentation:'warning',compact:true}));
 assert.match(warning,/上下文接近上限/);assert.doesNotMatch(warning,/ai-context-track/);
 const menu=renderToStaticMarkup(createElement(ContextUsage,{view:sample,presentation:'menu'}));
 assert.match(menu,/上下文用量/);assert.match(menu,/85.0%/);assert.match(menu,/aria-expanded="false"/);assert.doesNotMatch(menu,/ai-context-track|role="region"/);
 const unknown=renderToStaticMarkup(createElement(ContextUsage,{view:view(undefined),presentation:'menu'}));assert.match(unknown,/暂无实测/);
});
