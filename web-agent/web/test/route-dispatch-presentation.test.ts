import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard,SessionSnapshot} from '../../shared/contracts';
import {AITranscript} from '../src/AIPanel';
import {recoveredRouteFailures} from '../src/routeDispatchPresentation';
import {TurnExecutionDetails} from '../src/TurnExecutionDetails';

const at=(n:number)=>`2026-11-06T02:00:${String(n).padStart(2,'0')}Z`;
const receipt=(event='event',part='host')=>({eventId:event,partKey:part,action:'create',workerId:'worker',taskId:'task',dispatch:{state:'queued',unresolvedOperations:0}});
const route=(id:string,status:string,n:number,event='event',part='host'):AICard=>({id,type:'operation',title:'route_work',status,at:at(n),data:{arguments:{event_id:event,part_key:part,action:'create'}},content:status==='failed'?'Original routing error':JSON.stringify(receipt(event,part))});
function render(cards:AICard[],nextUser=false){
 const messages=[{id:'user',sessionId:'pilot',role:'user',text:'检查服务器',createdAt:at(0)},...(nextUser?[{id:'next-user',sessionId:'pilot',role:'user',text:'下一次检查',createdAt:at(3)}]:[])];
 const snapshot={session:{id:'pilot'},messages,resources:[],actions:[],ai:{session:'pilot',status:'completed',cardsOffset:0,cards}} as SessionSnapshot;
 return renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:'Pilot',pilot:true}}));
}
const notices=(html:string)=>[...html.matchAll(/class="turn-execution-notice">([^<]*)</g)].map(match=>match[1]);

test('only a later successful route for the exact admitted event and part recovers a prior routing failure',()=>{
 const failed=route('failed','failed',1),success=route('success','completed',2);
 const original=JSON.stringify([failed,success]);
 for(const status of ['completed','succeeded','success'])assert.deepEqual([...recoveredRouteFailures([failed,{...success,status}])],['failed']);
 assert.deepEqual([...recoveredRouteFailures([success,failed])],[],'a new error cannot borrow an earlier success');
 for(const later of [route('other-event','completed',2,'other'),route('other-part','completed',2,'event','other'),{...success,title:'inspect_host'},route('running','running',2),route('failed-again','failed',2)])assert.deepEqual([...recoveredRouteFailures([failed,later])],[]);
 assert.deepEqual([...recoveredRouteFailures([{...failed,title:'inspect_host'},success])],[],'real host failures never inherit routing recovery');
 assert.equal(JSON.stringify([failed,success]),original);
});

test('missing, malformed and ambiguous routing keys remain failures while exact JSON arguments are supported',()=>{
 const failed=route('failed','failed',1),success=route('success','completed',2);
 for(const args of [undefined,'broken-json',[],{}, {event_id:'event'}, {part_key:'host'}, {event_id:' ',part_key:'host'}, {event_id:'event',part_key:2}]){
  assert.equal(recoveredRouteFailures([{...failed,data:{arguments:args}},success]).size,0);
  assert.equal(recoveredRouteFailures([failed,{...success,data:{arguments:args}}]).size,0);
 }
 const json={...success,data:{arguments:JSON.stringify({event_id:'event',part_key:'host',action:'create'})}};
 assert.ok(recoveredRouteFailures([failed,json]).has('failed'));
 assert.equal(recoveredRouteFailures([route('space','failed',1,' event'),success]).size,0,'identity is exact, not trimmed or inferred');
});

test('recovery requires an actual host dispatch receipt, not a successful conversation decision or blocked handoff',()=>{
 const failed=route('failed','failed',1),success=route('success','completed',2);
 for(const result of [undefined,'not-json',{}, {...receipt(),eventId:'other'}, {...receipt(),partKey:'other'}, {...receipt(),workerId:''}, {...receipt(),taskId:''},
  {...receipt(),dispatch:undefined}, {...receipt(),dispatch:{state:'recorded'}}, {...receipt(),dispatch:{state:'needs_input'},handoff:{recorded:true}},
  {...receipt(),dispatch:{state:'limit_reached'},handoff:{recorded:true}}, {...receipt(),dispatch:{state:'queued',unresolvedOperations:1}}, {...receipt(),dispatch:{state:'running',unresolvedOperations:true}}]){
  assert.equal(recoveredRouteFailures([failed,{...success,content:typeof result==='string'?result:JSON.stringify(result)}]).size,0,JSON.stringify(result));
 }
 for(const action of ['respond','ask','context_only','stop']){
  const other={...success,data:{arguments:{event_id:'event',part_key:'host',action}},content:JSON.stringify({...receipt(),action,handoff:{recorded:true}})};
  assert.equal(recoveredRouteFailures([failed,other]).size,0,action);
 }
 assert.ok(recoveredRouteFailures([failed,{...success,content:JSON.stringify({...receipt(),dispatch:undefined,handoff:{recorded:true}})}]).has('failed'));
 assert.ok(recoveredRouteFailures([failed,{...success,content:JSON.stringify({...receipt(),dispatch:{state:'running'}})}]).has('failed'));
 assert.ok(recoveredRouteFailures([failed,{...success,content:JSON.stringify({...receipt(),dispatch:{state:'running',unresolvedOperations:false}})}]).has('failed'));
 const followup={...success,data:{arguments:{event_id:'event',part_key:'host',action:'followup'}},content:JSON.stringify({...receipt(),action:'followup'})};
 assert.ok(recoveredRouteFailures([{...failed,data:followup.data},followup]).has('failed'));
});

test('the main failure caption excludes recovered routing only; raw process and other failures stay intact',()=>{
 const cards=[route('failed','failed',1),route('success','completed',2)];
 const before=JSON.stringify(cards),html=render(cards);
 assert.deepEqual(notices(html),[]);
 assert.ok(html.includes('data-conversation-entry="failed"')&&html.includes('执行失败'),'the original failed row remains in execution details');
 const host={...route('host','failed',4),title:'inspect_host'};
 assert.deepEqual(notices(render([...cards,host])),[' · 1 项失败']);
 const other=route('other','failed',4,'other-event');
 assert.deepEqual(notices(render([...cards,other])),[' · 1 项失败']);
 assert.deepEqual(notices(render([cards[0]!,{...cards[1]!,at:at(4)}],true)),[' · 1 项失败'],'recovery cannot cross user turns');
 assert.equal(JSON.stringify(cards),before,'presentation must preserve the persisted failure status and body');
});

test('recovered routing cannot remain the latest failed operation while the model continues thinking',()=>{
 const cards=[route('failed','failed',1),route('success','completed',2)];
 const renderState=(records:AICard[])=>renderToStaticMarkup(createElement(TurnExecutionDetails,{cards:records,view:{session:'pilot',status:'running',cards:records,turnStartedAt:at(0)} as SessionSnapshot['ai'],latestUserAt:at(0),details:[createElement('span',{key:'audit'},'original audit retained')]}));
 const html=renderState(cards);
 assert.match(html,/正在思考/);assert.ok(!html.includes('turn-current-step'));
 assert.ok(html.includes('original audit retained'));
 assert.ok(renderState([cards[0]!]).includes('turn-current-step'),'unrecovered routing failures still require attention');
 assert.ok(renderState([...cards,{...route('host','failed',3),title:'inspect_host'}]).includes('turn-current-step'),'real operation failures are never cleared by routing recovery');
});
