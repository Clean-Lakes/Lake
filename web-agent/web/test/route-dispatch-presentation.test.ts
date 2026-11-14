import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard,SessionSnapshot} from '../../shared/contracts';
import {AITranscript} from '../src/AIPanel';
import {pilotHandoffInterimIds,recoveredRouteFailures} from '../src/routeDispatchPresentation';
import {orderedTranscript} from '../src/timeline';
import {ToolStep} from '../src/ThinkingTimeline';
import {RoutingRecoveryContext,TurnExecutionDetails} from '../src/TurnExecutionDetails';
import {confirmsDispatch,routingCall} from '../../shared/route-dispatch';

const at=(n:number)=>`2026-11-06T02:00:${String(n).padStart(2,'0')}Z`;
const receipt=(event='event',part='host')=>({eventId:event,partKey:part,action:'create',workerId:'worker',taskId:'task',dispatch:{state:'queued',unresolvedOperations:0}});
const route=(id:string,status:string,n:number,event='event',part='host'):AICard=>({id,type:'operation',title:'route_work',status,at:at(n),data:{arguments:{event_id:event,part_key:part,action:'create'}},content:status==='failed'?'Original routing error':JSON.stringify(receipt(event,part))});
function render(cards:AICard[],nextUser=false){
 const messages=[{id:'user',sessionId:'pilot',role:'user',text:'检查服务器',createdAt:at(0)},...(nextUser?[{id:'next-user',sessionId:'pilot',role:'user',text:'下一次检查',createdAt:at(3)}]:[])];
 const snapshot={session:{id:'pilot'},messages,resources:[],actions:[],ai:{session:'pilot',status:'completed',cardsOffset:0,cards}} as SessionSnapshot;
 return renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:'Pilot',pilot:true}}));
}
const notices=(html:string)=>[...html.matchAll(/class="turn-execution-notice">([^<]*)</g)].map(match=>match[1]);

test('a followup handoff can explicitly create an independent readonly recheck for that exact source',()=>{
 const card={...route('recheck','completed',1),data:{arguments:{event_id:'event',part_key:'host',action:'followup',task_id:'source',role_id:'role'}}};
 const result={...receipt(),action:'create',taskId:'fresh',recoveryOfTaskId:'source',assignments:[{executionId:'fresh',workerId:'new-worker',sessionId:'new-session',roleId:'role',dispatch:{state:'queued',unresolvedOperations:0}}],handoff:{recorded:true}};
 const call=routingCall(card)!;
 assert.equal(confirmsDispatch({...card,content:JSON.stringify(result)},call),true);
 for(const changed of [{...result,recoveryOfTaskId:'other'},{...result,taskId:'source'},{...result,assignments:[{...result.assignments[0],executionId:'other'}]},
  {...result,assignments:[{...result.assignments[0],roleId:'other'}]},{...result,assignments:[{...result.assignments[0],dispatch:{state:'queued',unresolvedOperations:1}}]}])
  assert.equal(confirmsDispatch({...card,content:JSON.stringify(changed)},call),false);
});

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
 assert.deepEqual(notices(html),[' · 1 项派单重试后已恢复']);
 assert.ok(html.includes('data-conversation-entry="failed"')&&html.includes('重试后已恢复'),'the original failed row remains in execution details');
 const host={...route('host','failed',4),title:'inspect_host'};
 assert.deepEqual(notices(render([...cards,host])),[' · 1 项派单重试后已恢复 · 1 项失败']);
 const other=route('other','failed',4,'other-event');
 assert.deepEqual(notices(render([...cards,other])),[' · 1 项派单重试后已恢复 · 1 项失败']);
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

const bound=(card:AICard,root='root'):AICard=>({...card,data:{...card.data as object,root_turn_id:root}});
const prose=(id:string,n:number,content:string,status='completed')=>bound({id,type:'message',status,content,at:at(n)});
const handoff=()=>[prose('before',1,'我安排重新检查运行时长。'),bound(route('dispatch','completed',2)),prose('after',3,'已安排重新检查运行时长。')];
function handoffSnapshot(cards:AICard[],status='completed'):SessionSnapshot {
 return {session:{id:'pilot',workspaceRole:'router'},messages:[{id:'user',sessionId:'pilot',role:'user',text:'再查一下',createdAt:at(0)}],resources:[],actions:[],ai:{session:'pilot',status,cardsOffset:0,cards}} as SessionSnapshot;
}
const interim=(cards:AICard[])=>pilotHandoffInterimIds(orderedTranscript(handoffSnapshot(cards),cards,0));
function handoffHTML(snapshot:SessionSnapshot,pilot=true){return renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:{name:pilot?'Pilot':'普通助手',pilot}}))}
const mainReply=(html:string)=>html.split(/<div[^>]*class="turn-execution-details/)[0]!;

test('confirmed pure delegation retires the preamble only after a real reply, retaining its original audit and reply identity',()=>{
 for(const status of ['running','completed']){
  const cards=handoff();cards[2]={...cards[2]!,status};
  const original=JSON.stringify(cards),html=handoffHTML(handoffSnapshot(cards,status)),main=mainReply(html);
  assert.deepEqual([...interim(cards)],['before']);
  assert.ok(!main.includes('我安排重新检查运行时长。'));
  assert.ok(main.includes('已安排重新检查运行时长。'));
  assert.equal((main.match(/<strong>Pilot<\/strong>/g)??[]).length,1,'surviving reply retains its Pilot identity');
  assert.ok(!main.includes('is-reply-continuation'),'a retired preamble cannot suppress the actual reply identity');
  assert.ok(html.includes('我安排重新检查运行时长。')&&html.includes('data-conversation-entry="dispatch"'),'original preamble and receipt remain inspectable');
  assert.equal(JSON.stringify(cards),original);
 }
 const pending=handoff().slice(0,2);
 assert.equal(interim(pending).size,0,'confirmation cannot be invented');
 assert.ok(mainReply(handoffHTML(handoffSnapshot(pending,'running'))).includes('我安排重新检查运行时长。'));
 assert.equal(interim([...pending,prose('empty',3,'','running')]).size,0);
});

test('handoff projection preserves business findings, restrictions, ambiguous binding and unrelated rounds',()=>{
 const base=handoff(),dispatch=base[1]!;
 for(const operation of [
  {...dispatch,status:'running'}, {...dispatch,status:'failed'}, {...dispatch,status:'pending'}, {...dispatch,status:'unknown'},
  {...dispatch,content:'{}'}, {...dispatch,content:JSON.stringify({...receipt(),eventId:'different'})},
  {...dispatch,content:JSON.stringify({...receipt(),dispatch:{state:'needs_input'},handoff:{recorded:true}})},
  {...dispatch,content:JSON.stringify({...receipt(),dispatch:{state:'queued',unresolvedOperations:1}})},
  {...dispatch,data:{arguments:{event_id:'event',part_key:'host',action:'create'}}},
 ])assert.equal(interim([base[0]!,operation,base[2]!]).size,0,JSON.stringify(operation));
 for(const title of ['Bash','inspect_host','read_super_object','read_tool_result','unknown_tool']){
  const business=bound({id:'business',type:'operation',title,status:'completed',at:at(2)});
  assert.equal(interim([base[0]!,business,dispatch,base[2]!]).size,0,title);
 }
 assert.equal(interim([base[0]!,dispatch,bound(base[2]!,'another-root')]).size,0);
 assert.equal(interim([bound(base[0]!,'another-root'),dispatch,base[2]!]).size,0);
 assert.equal(interim([...base,bound({id:'error',type:'error',status:'failed',content:'模型连接失败',at:at(4)})]).size,0);
 const entries=orderedTranscript(handoffSnapshot(base),base,0);
 assert.equal(pilotHandoffInterimIds(entries.filter(entry=>!entry.message)).size,0,'clipped history has no complete user boundary');
 assert.equal(pilotHandoffInterimIds([...entries,{id:'question',at:at(4),action:{} as NonNullable<typeof entries[number]['action']>}]).size,0);
 const next={id:'next',at:at(2),message:{id:'next',sessionId:'pilot',role:'user',text:'另一项',createdAt:at(2)}};
 assert.equal(pilotHandoffInterimIds([...entries,next]).size,0,'never cross independent user turns');
});

test('independent assignments share one final confirmation without combining later role reports or distinct findings',()=>{
 const cards=[prose('before',1,'我安排两项检查。'),bound(route('one','completed',2)),prose('middle',3,'第一项已安排，继续第二项。'),bound(route('two','completed',4,'event','second')),prose('after',5,'两项检查已分别安排。'),prose('finding',6,'上次记录仅用于历史参考。')];
 const original=JSON.stringify(cards);
 assert.deepEqual([...interim(cards)],['before','middle']);
 const snapshot=handoffSnapshot(cards);
 snapshot.messages.push({id:'report',sessionId:'pilot',role:'assistant',text:'服务器检查的实际结果。',createdAt:at(7),author:{roleId:'ops',workerId:'worker',name:'运维专员'} as NonNullable<SessionSnapshot['messages'][number]['author']>});
 const html=mainReply(handoffHTML(snapshot));
 assert.ok(html.includes('两项检查已分别安排。')&&html.includes('上次记录仅用于历史参考。')&&html.includes('服务器检查的实际结果。'));
 assert.ok(html.includes('运维专员')&&html.includes('is-role-break'));
 assert.equal(JSON.stringify(cards),original);
 const reportBeforeFinal={id:'report',at:at(2),message:snapshot.messages[1]!};
 assert.equal(pilotHandoffInterimIds([orderedTranscript(snapshot,cards,0)[0]!,{id:'before',at:at(1),card:cards[0]},reportBeforeFinal,...cards.slice(1).map(card=>({id:card.id,at:card.at,card}))]).size,1,'a role boundary protects the earlier packet while a later independent preamble can still retire');
});

test('ordinary tool replies also retire narration, while clipped pages and pending controls retain context',()=>{
 const snapshot=handoffSnapshot(handoff());
 assert.ok(!mainReply(handoffHTML(snapshot,false)).includes('我安排重新检查运行时长。'));
 assert.ok(handoffHTML(snapshot,false).includes('我安排重新检查运行时长。'));
 snapshot.ai!.cardsOffset=1;
 assert.ok(mainReply(handoffHTML(snapshot)).includes('我安排重新检查运行时长。'));
 snapshot.ai!.cardsOffset=0;snapshot.ai!.question={} as NonNullable<NonNullable<SessionSnapshot['ai']>['question']>;
 assert.ok(mainReply(handoffHTML(snapshot)).includes('我安排重新检查运行时长。'));
});

test('HTTP-inserted dispatch forwarding bridges only its exact successful receipt and source user',()=>{
 const cards=handoff();cards[1]={...cards[1]!,content:JSON.stringify({...receipt(),id:'receipt'})};
 const snapshot=handoffSnapshot(cards);
 const dispatch={id:'receipt',sourceMessageId:'user',workerId:'worker',sessionId:'worker-session',taskId:'task',roleId:'ops',roleName:'运维专员',instruction:'重新检查运行时长',action:'create'} as const;
 snapshot.messages.push({id:'forward',sessionId:'pilot',role:'assistant',text:'内部转发',createdAt:at(2),dispatch});
 snapshot.ai!.cardsOffset=122;
 // A clipped earlier turn must not disable folding a later complete turn.
 snapshot.messages.unshift({id:'earlier',sessionId:'pilot',role:'user',text:'前一轮',createdAt:'2026-11-05T00:00:00Z'});
 cards.unshift(bound({id:'earlier-card',type:'message',status:'completed',content:'前一轮的回复',at:'2026-11-05T00:01:00Z'},'earlier-root'));
 const html=handoffHTML(snapshot),main=mainReply(html);
 assert.ok(!main.includes('我安排重新检查运行时长。')&&!html.includes('内部转发'));
 assert.ok(main.includes('已安排重新检查运行时长。')&&html.includes('我安排重新检查运行时长。'));
 const entries=orderedTranscript(snapshot,cards,0).filter(entry=>entry.id!=='earlier');
 assert.deepEqual([...pilotHandoffInterimIds(entries)],['before']);
 for(const changed of [{id:'other'},{sourceMessageId:'other'},{workerId:'other'},{taskId:'other'},{action:'followup'}]){
  const altered=entries.map(entry=>entry.id==='forward'?{...entry,message:{...entry.message!,dispatch:{...dispatch,...changed}}}:entry);
  assert.equal(pilotHandoffInterimIds(altered).size,0,JSON.stringify(changed));
 }
});

test('joint handoff folds only with all requested members and each exact forwarded session',()=>{
 const cards=handoff(),members=['a','b'].map(roleId=>({roleId,workerId:'w'+roleId,sessionId:'s'+roleId,dispatch:{state:'queued'}}));
 const call={event_id:'event',part_key:'host',action:'assign',task_id:'shared',role_ids:['b','a']};
 const result={eventId:'event',partKey:'host',action:'assign',id:'decision',taskId:'shared',assignments:members,handoff:{recorded:true}};
 cards[1]=bound({...cards[1]!,data:{arguments:call},content:JSON.stringify(result)});
 const entries=orderedTranscript(handoffSnapshot(cards),cards,0);
 const before=entries.slice(0,-1),final=entries.at(-1)!;
 const forwards=members.map(member=>({id:'f'+member.roleId,at:at(2),message:{id:'f'+member.roleId,role:'assistant',text:'',sessionId:'pilot',createdAt:at(2),dispatch:{
  ...member,id:'decision',sourceMessageId:'user',roleName:member.roleId,instruction:'检查',action:'create' as const,taskId:'shared',
 }}}));
 const folded=(extra:typeof forwards)=>pilotHandoffInterimIds([...before,...extra,final]).has('before');
 assert.ok(folded(forwards));
 assert.ok(!folded([forwards[0]!,{...forwards[1]!,message:{...forwards[1]!.message,dispatch:{...forwards[1]!.message.dispatch,sessionId:'sa'}}}]));
 for(const assignments of [[members[0]],[members[0],members[0]],[members[0],{...members[1],dispatch:{state:'needs_input'}}]]){
  assert.equal(interim([cards[0]!,{...cards[1]!,content:JSON.stringify({...result,assignments})},cards[2]!]).size,0);
 }
 const failed=bound({...cards[1]!,id:'earlier',status:'failed',data:{arguments:{...call,role_ids:['a']}}});
 assert.equal(recoveredRouteFailures([failed,cards[1]!]).size,0);
});


test('corrected recipient recovery requires the host proof and matching later receipt in the same root and request',()=>{
 const failed=bound({...route('typo','failed',1),content:'记录不存在',data:{arguments:{event_id:'event',part_key:'host',action:'create',role_id:'mistyped',title:'检查',quote:'检查服务器',resource_ids:['host']},routingRecovery:{kind:'corrected_missing_specialist',recoveredBy:'corrected'}}});
 const success=bound({...route('corrected','completed',2),data:{arguments:{...(failed.data as any).arguments,role_id:'ops'}},content:JSON.stringify({...receipt(),roleId:'ops'})});
 assert.deepEqual([...recoveredRouteFailures([failed,success])],['typo']);
 const html=render([failed,success]);assert.deepEqual(notices(html),[' · 1 项派单重试后已恢复']);
 const detail=renderToStaticMarkup(createElement(RoutingRecoveryContext.Provider,{value:recoveredRouteFailures([failed,success])},createElement(ToolStep,{card:failed})));
 assert.ok(detail.includes('首次失败 · 重试后已恢复'));assert.ok(!detail.includes('step-failed'));assert.ok(detail.includes('step-recovered'));
 assert.ok(renderToStaticMarkup(createElement(ToolStep,{card:failed})).includes('step-failed'));
 for(const data of [{...(failed.data as any),routingRecovery:undefined},{...(failed.data as any),routingRecovery:{kind:'corrected_missing_specialist',recoveredBy:'absent'}}])
  assert.equal(recoveredRouteFailures([{...failed,data},success]).size,0);
 for(const change of [{title:'other'},{quote:'other'},{resource_ids:['different']},{role_instructions:[{role_id:'ops',instruction:'other'}]}]){
  const changed={...success,data:{...(success.data as any),arguments:{...(success.data as any).arguments,...change}}};
  assert.equal(recoveredRouteFailures([failed,changed]).size,0);
 }
 assert.equal(recoveredRouteFailures([failed,bound(success,'other-root')]).size,0);
 assert.equal(recoveredRouteFailures([failed,{...success,content:JSON.stringify({...receipt(),roleId:'other'})}]).size,0);
 assert.equal(recoveredRouteFailures([failed,{...success,content:JSON.stringify({...receipt(),roleId:'ops',dispatch:{state:'needs_input'}})}]).size,0);
 assert.equal(recoveredRouteFailures([success,failed]).size,0);
 assert.deepEqual(notices(render([failed,{...success,at:at(4)}],true)),[' · 1 项失败']);
});

test('unchanged recipients cannot recover changed scope, instructions, deliverable or SDK root',()=>{
 const failed=bound(route('failed','failed',1)),success=bound(route('success','completed',2));
 for(const change of [{title:'other'},{resource_ids:['other']},{quote:'other'},{role_instructions:[{role_id:'ops',instruction:'other'}]}])
  assert.equal(recoveredRouteFailures([failed,{...success,data:{...(success.data as any),arguments:{...(success.data as any).arguments,...change}}}]).size,0);
 assert.equal(recoveredRouteFailures([failed,bound(success,'other-root')]).size,0);
});
