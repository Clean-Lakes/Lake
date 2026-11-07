import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {OperationReview, SessionSnapshot} from '../../shared/contracts';
import {api} from '../src/api';
import {OperationReviewForm, reviewConfirmation, reviewableCommandIds} from '../src/OperationReconciliation';

const evidence={operationId:'later',at:'2026-11-07T00:00:30Z',summary:'同目录只读核对',command:'stat metadata',sessionId:'observer',taskId:'check'};
const view:OperationReview={operationId:'original',eligible:true,revision:'current-revision',command:'original shell',directory:'/tmp/run',evidence:[evidence]};

test('review candidates belong to the exact worker session and its execution, never a sibling sharing a task',()=>{
 const task={taskId:'shared',executionGoalId:'execution-B',projectId:'p',sessionId:'worker-B'};
 const source={session:{id:'worker-B',projectId:'p',workspaceRole:'worker'},superagent:{task},commandExecutions:[
  {operationId:'A',taskId:'execution-A',sessionId:'worker-A',operationState:'unknown'},
  {operationId:'B',taskId:'execution-B',sessionId:'worker-B',operationState:'unknown'},
  {operationId:'foreign-session',taskId:'execution-B',sessionId:'worker-A',operationState:'unknown'},
  {operationId:'known-failure',taskId:'execution-B',sessionId:'worker-B',operationState:'failed'},
 ]} as SessionSnapshot;
 assert.deepEqual(reviewableCommandIds(source,'execution-B'),['B']);
 assert.deepEqual(reviewableCommandIds(source,'shared'),[]);
 assert.deepEqual(reviewableCommandIds({...source,session:{...source.session,workspaceRole:'role'}},'execution-B'),[]);
});

test('an unselected, stale, original, unresolved choice or unchecked judgement cannot submit',()=>{
 const note='同一目录的独立快照一致。';
 for(const args of [
   [view,'',note,true],[view,'another',note,true],[view,'later',' ',true],[view,'later',note,false],
   [{...view,resolved:true},'later',note,true],[{...view,eligible:false},'later',note,true],
   [{...view,revision:undefined},'later',note,true],[{...view,evidence:[{...evidence,operationId:'original'}]},'original',note,true],
 ] as Parameters<typeof reviewConfirmation>[]) assert.equal(reviewConfirmation(...args),undefined);
 assert.deepEqual(reviewConfirmation(view,'later',note,true),{revision:'current-revision',evidenceOperationId:'later',confirmNoWrite:true,note});
 const render=(review:OperationReview)=>renderToStaticMarkup(createElement(OperationReviewForm,{review,connected:true,busy:false,failed:'',onSubmit(){},onRefresh(){}}));
 const html=render(view);
 assert.match(html,/选择独立复查回执/);assert.match(html,/type="submit"[^>]*disabled/);
 assert.doesNotMatch(render({...view,evidence:[]}),/type="submit"/);
 assert.equal(render({...view,eligible:false}),'');
 assert.doesNotMatch(render({...view,resolved:true}),/登记复核结果|type="submit"|验收通过/);
});

test('review GET and deliberate confirmation POST both target the original session and operation',async t=>{
 const calls:{url:string;method:string;body?:unknown}[]=[];
 t.mock.method(globalThis,'fetch',async(url:string,init?:RequestInit)=>{
  calls.push({url,method:init?.method??'GET',body:init?.body&&JSON.parse(String(init.body))});
  return new Response(JSON.stringify(calls.length===1?view:{operationId:'op/2',resolved:true}),{status:200});
 });
 await api.operationReview('session/1','op/2');assert.equal(calls.length,1);
 const confirmation=reviewConfirmation(view,'later','核验真实回执',true)!;
 await api.confirmOperationReview('session/1','op/2',confirmation);
 assert.deepEqual(calls.map(c=>[c.url,c.method]),[['/api/sessions/session%2F1/operation-reconciliation/op%2F2','GET'],['/api/sessions/session%2F1/operation-reconciliation/op%2F2','POST']]);
 assert.deepEqual(calls[1].body,confirmation);
});

test('observed change has a distinct explicit decision and never records a no-write statement',()=>{
 const reviewed={...view,effects:'observed' as const};
 assert.deepEqual(reviewConfirmation(reviewed,'later','已删除标志并复核现状',true),
   {revision:view.revision,evidenceOperationId:'later',confirmObservedEffects:true,note:'已删除标志并复核现状'});
 const html=renderToStaticMarkup(createElement(OperationReviewForm,{review:reviewed,connected:true,busy:false,failed:'',onSubmit(){},onRefresh(){}}));
 assert.match(html,/实际变更/); assert.doesNotMatch(html,/确认原操作未写入/);
});
