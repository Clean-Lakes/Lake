import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {OperatorEffectReview} from '../../shared/contracts';
import {api} from '../src/api';
import {OperatorEffectReviewForm,operatorEffectConfirmation,type OperatorEffectDraft} from '../src/OperatorEffectReconciliation';

const draft:OperatorEffectDraft={directory:'/tmp/review',evidenceOperationId:'observation',effects:'observed',
  actualEffects:'配置已改，服务仍在运行。',processDisposition:'原 wrapper 已退出，保留服务的身份和管理者已独立确认。',
  remainingWork:'仍需业务验收。',operatorName:'授权测试员',note:'对照原命令与同主机的完整目录观察。'};
const checks={source:true,effects:true,processes:true};
const review:OperatorEffectReview={operationId:'original',eligible:true,revision:'revision',command:'original command',output:'cancelled, exitCode=0',
  executionStatus:'cancelled',backgroundTaskId:'ssh-original',directories:['/tmp/review'],evidence:[{operationId:'observation',directory:'/tmp/review',
    sessionId:'observer',taskId:'observer-task',at:'2026-11-08T00:00:00Z',summary:'完整目录观察',output:'{"complete":true}'}]};

test('an operator must separately inspect source, all effects and process disposition before recording',()=>{
  for(const flag of ['source','effects','processes'] as const)assert.equal(operatorEffectConfirmation(review,draft,{...checks,[flag]:false}),undefined);
  for(const key of ['actualEffects','processDisposition','remainingWork','operatorName','note'] as const)
    assert.equal(operatorEffectConfirmation(review,{...draft,[key]:' '},checks),undefined);
  for(const d of [{...draft,effects:'' as const},{...draft,directory:'/tmp/unrelated'},{...draft,evidenceOperationId:'original'}])
    assert.equal(operatorEffectConfirmation(review,d,checks),undefined);
  assert.equal(operatorEffectConfirmation({...review,evidence:[{...review.evidence[0],directory:'/tmp/unrelated'}]},draft,checks),undefined);
  const result=operatorEffectConfirmation(review,draft,checks)!;
  assert.equal(result.effects,'observed');assert.equal(result.reconcileRisk,undefined);assert.equal(result.operatorName,'授权测试员');
});

test('closure needs a new deliberate confirmation of the immutable recorded judgment',()=>{
  const recorded:OperatorEffectReview={...review,eligible:false,recorded:true,closureEligible:true,judgment:{...draft,effects:'observed'}};
  assert.equal(operatorEffectConfirmation(recorded,draft,{...checks,processes:false}),undefined);
  assert.equal(operatorEffectConfirmation(recorded,{...draft,note:'换一份理由'},checks),undefined);
  assert.equal(operatorEffectConfirmation({...recorded,closureState:'reconciled'},draft,checks),undefined);
  assert.equal(operatorEffectConfirmation(recorded,draft,checks)?.reconcileRisk,true);
  const none={...draft,effects:'none' as const};
  assert.equal(operatorEffectConfirmation(review,none,checks)?.effects,'none');
});

test('the form explains observation limits, shows original failures and starts with all decisions unconfirmed',()=>{
  const render=(r:OperatorEffectReview)=>renderToStaticMarkup(createElement(OperatorEffectReviewForm,{review:r,connected:true,busy:false,error:'',onSubmit(){},onRefresh(){}}));
  const html=render(review);
  assert.match(html,/不能据此认定远程进程已停止/);assert.match(html,/original command/);assert.match(html,/cancelled, exitCode=0/);
  assert.match(html,/登记人工判定/);assert.match(html,/type="submit"[^>]*disabled/);assert.doesNotMatch(html,/checked=""/);
  assert.equal(render({...review,eligible:false}),'');
  assert.doesNotMatch(render({...review,closureState:'reconciled'}),/type="submit"|验收通过/);
});

test('authenticated review calls preserve exact original session and operation IDs',async t=>{
  const calls:{url:string;method:string;body:unknown}[]=[];
  t.mock.method(globalThis,'fetch',async(url:string,init?:RequestInit)=>{
    calls.push({url,method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):undefined});
    return new Response(JSON.stringify(calls.length===1?review:{operationId:'op/2',recorded:true}),{status:200});
  });
  await api.operatorEffectReview('session/1','op/2');
  const body=operatorEffectConfirmation(review,draft,checks)!;
  await api.confirmOperatorEffectReview('session/1','op/2',body);
  assert.deepEqual(calls.map(c=>[c.url,c.method]),[
    ['/api/sessions/session%2F1/operator-effect-review/op%2F2','GET'],
    ['/api/sessions/session%2F1/operator-effect-review/op%2F2','POST']]);
  assert.deepEqual(calls[1].body,body);
});
