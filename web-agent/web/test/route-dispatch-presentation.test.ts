import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard,SessionSnapshot} from '../../shared/contracts';
import {AITranscript} from '../src/AIPanel';
import {pilotHandoffInterimIds,recoveredRouteFailures} from '../src/routeDispatchPresentation';
import {orderedTranscript} from '../src/timeline';
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

test('ordinary assistants, clipped pages and pending user controls keep their original prose',()=>{
 const snapshot=handoffSnapshot(handoff());
 assert.ok(mainReply(handoffHTML(snapshot,false)).includes('我安排重新检查运行时长。'));
 snapshot.ai!.cardsOffset=1;
 assert.ok(mainReply(handoffHTML(snapshot)).includes('我安排重新检查运行时长。'));
 snapshot.ai!.cardsOffset=0;snapshot.ai!.question={} as NonNullable<NonNullable<SessionSnapshot['ai']>['question']>;
 assert.ok(mainReply(handoffHTML(snapshot)).includes('我安排重新检查运行时长。'));
});
