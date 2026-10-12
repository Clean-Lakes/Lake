import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextUsage } from '../src/ContextUsage';
import type { AIView } from '../../shared/contracts';

const view = (context: AIView['context']): AIView => ({session:'usage-fixture',status:'completed',cards:[],turns:1,profile:'core',cardsOffset:0,totalCards:0,usage:{input:640000,output:442,total:640442,known:true},context});
test('context percentage uses measured input and provider capacity, not estimate or total spend', () => {
 const html=renderToStaticMarkup(createElement(ContextUsage,{view:view({window:1000000,windowSource:'provider',budget:64000,used:30800,usedKnown:true,estimated:false,estimatedUsed:67800,lastRequest:{input:30800,output:442,total:31242,inputKnown:true,outputKnown:true,known:true}})}));
 assert.match(html,/上下文 3.1%/);
 assert.doesNotMatch(html,/106%|64%/);
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
