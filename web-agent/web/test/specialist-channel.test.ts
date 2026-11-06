import {test} from 'node:test';
import {SpecialistTaskMenu} from '../src/SpecialistTaskMenu';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {channelTasksByRecentRecord,mergeChannelEntries,preferredChannelTask,SpecialistChannelEntries,SpecialistTaskControls,SpecialistTaskSelect} from '../src/SpecialistChannel';
import type {SessionSnapshot,SpecialistChannelEntry,SuperWorker} from '../../shared/contracts';
import {isCompactionFallbackEntry} from '../src/timeline';
import {TranscriptMessage} from '../src/AIPanel';
import {completedTurnInterimIds} from '../src/completedTurnProse';

test('Pilot and specialist chats omit internal handoffs while keeping direct input and replies',()=>{
 const at='2026-11-04T01:00:00Z';
 const message={id:'dispatch-message',sessionId:'pilot',role:'assistant' as const,text:'@数据库专员，请去做一下：核对两端 MySQL 数据',createdAt:at,dispatch:{id:'decision',sourceMessageId:'original-user',workerId:'worker',sessionId:'worker-session',taskId:'task',roleId:'stable-role',roleName:'数据库专员',channelSessionId:'channel',instruction:'核对两端 MySQL 数据',action:'create' as const}};
 const channelHTML=renderToStaticMarkup(createElement(TranscriptMessage,{message,sessionId:'pilot',hideIdentity:true}));
 assert.equal(channelHTML,'');
 const pilotHTML=renderToStaticMarkup(createElement(TranscriptMessage,{message,sessionId:'pilot',onSpecialist:()=>{}}));
 assert.equal(pilotHTML,'');
 assert.equal(message.dispatch.instruction,'核对两端 MySQL 数据','display filtering preserves the source record');
 const followup={...message,dispatch:{...message.dispatch,action:'followup' as const,instruction:'只比较业务表'}};
 const followupHTML=renderToStaticMarkup(createElement(TranscriptMessage,{message:followup,sessionId:'pilot',hideIdentity:true}));
 assert.equal(followupHTML,'');
 const entry={id:'dispatch',sourceSessionId:'pilot',createdAt:at,message};
 const entries:SpecialistChannelEntry[]=[
  {id:'cached-old-bubble',sourceSessionId:'pilot',createdAt:at,message:{id:'original-user',sessionId:'pilot',role:'user',createdAt:at,text:'ORIGINAL PILOT USER INPUT'}},
  entry,
  {id:'followup',sourceSessionId:'pilot',createdAt:at,message:followup},
  {id:'direct',sourceSessionId:'channel',createdAt:at,message:{id:'direct',sessionId:'channel',role:'user',createdAt:at,text:'MY DIRECT SPECIALIST INPUT'}},
  {id:'reply',sourceSessionId:'worker-session',createdAt:at,message:{id:'reply',sessionId:'worker-session',role:'assistant',createdAt:at,text:'已核对完成，Pilot 是项目里的协调者。'}},
 ];
 const original=JSON.stringify(entries);
 const html=renderToStaticMarkup(createElement(SpecialistChannelEntries,{entries,resources:[]}));
 assert.ok(!html.includes('ORIGINAL PILOT USER INPUT'));
 assert.ok(!html.includes('核对两端 MySQL 数据')&&!html.includes('只比较业务表')&&!html.includes('data-channel-entry="dispatch"')&&!html.includes('data-channel-entry="followup"'));
 assert.ok(html.includes('MY DIRECT SPECIALIST INPUT')&&html.includes('ai-role-user'));
 assert.ok(html.includes('已核对完成，Pilot 是项目里的协调者。'),'ordinary prose is not filtered by keywords');
 assert.equal(JSON.stringify(entries),original,'handoff instructions and source records remain intact');
 const turn=[{id:'dispatch',at,message},{id:'operation',at,card:{id:'operation',type:'operation',status:'completed',at}},{id:'final',at,card:{id:'final',type:'message',status:'completed',content:'已完成',at}}];
 assert.ok(!completedTurnInterimIds(turn,true).has('dispatch'),'display filtering does not rewrite timeline source metadata');
});

test('channel pagination and retries use source identity rather than report body',()=>{
 const entry=(id:string,at:string,source='worker-a'):SpecialistChannelEntry=>({id,sourceSessionId:source,taskId:`task-${source}`,createdAt:at,message:{id,sessionId:source,role:'assistant',text:'相同正文',createdAt:at}});
 const newer=entry('a','2026-11-03T01:00:01Z'),older=entry('b','2026-11-03T01:00:00Z','worker-b');
 const updated={...newer,message:{...newer.message!,text:'流式更新'}};
 const result=mergeChannelEntries([newer],[older,updated]);
 assert.deepEqual(result.map(item=>item.id),['b','a']);
 assert.equal(result[0]?.sourceSessionId,'worker-b');assert.equal(result[1]?.message?.text,'流式更新');
 assert.equal(mergeChannelEntries(result,[older]).length,2);
});

test('persisted channel diagnostics are quiet without filtering human or assistant quotations',()=>{
 const text='历史上下文整理未完成，已保留原上下文继续本轮对话。';
 const base={id:'diagnostic',sourceSessionId:'worker-a',taskId:'task-a',createdAt:'2026-11-03T01:00:01Z'};
 const card={...base,card:{id:'fallback',type:'notice',status:'completed',content:text,at:base.createdAt}};
 const message=(role:'user'|'assistant'|'system'):SpecialistChannelEntry=>({...base,message:{id:'message',sessionId:base.sourceSessionId,role,text,createdAt:base.createdAt}});
 const entries=[card,message('system'),message('user'),message('assistant')];
 const before=JSON.stringify(entries);
 assert.deepEqual(entries.map(isCompactionFallbackEntry),[true,true,false,false]);
 assert.equal(entries.filter(entry=>!isCompactionFallbackEntry(entry)).length,2);
 assert.equal(JSON.stringify(entries),before,'raw channel history and source identities stay intact');
});

test('two waiting task controls expose both original questions and approvals without enabling a disconnected channel',()=>{
 const snapshot=(id:string):SessionSnapshot=>({session:{id,title:`Task ${id}`},messages:[],resources:[],ai:{question:{id:`question-${id}`,questions:[{id:'work_contract',title:`Confirm task ${id}`,options:[{label:`Only ${id}`}]}]},pending:{id:`approval-${id}`,kind:'resource_select',risk:'readonly',target:`Host ${id}`,fingerprint:`fingerprint-${id}`,needsTerminal:false,call:{id:`call-${id}`,name:'inspect_host',arguments:'{}'}}}} as unknown as SessionSnapshot);
 const html=renderToStaticMarkup(createElement('div',null,...['A','B'].map(id=>createElement(SpecialistTaskControls,{key:id,snapshot:snapshot(id),connected:true}))));
 for(const id of ['A','B']){
  assert.ok(html.includes(`Confirm task ${id}`));
  assert.ok(html.includes(`question-question-${id}-work_contract`));
  assert.ok(html.includes(`Host ${id}`));
 }
 assert.equal((html.match(/>提交并继续/g)??[]).length,2);
 assert.equal((html.match(/>使用此资源<\/button>/g)??[]).length,2);
 assert.match(renderToStaticMarkup(createElement(SpecialistTaskControls,{snapshot:snapshot('A'),connected:false})),/<fieldset[^>]*disabled=""/);
});

test('channel task boundaries use exact task identity while keeping each task’s prose continuous',()=>{
 const at='2026-11-04T01:00:00Z';
 const entries:SpecialistChannelEntry[]=[
  {id:'reply',sourceSessionId:'worker-a',taskId:'task-a',createdAt:at,message:{id:'reply',sessionId:'worker-a',role:'assistant',text:'已取得磁盘证据',createdAt:at}},
  {id:'more',sourceSessionId:'worker-a',taskId:'task-a',createdAt:at,message:{id:'more',sessionId:'worker-a',role:'assistant',text:'这是同一任务的后续说明',createdAt:at}},
  {id:'blocked',sourceSessionId:'worker-b',taskId:'task-b',createdAt:at,card:{id:'blocked',type:'error',status:'failed',content:'需要核实原操作',at}},
 ];
 const workers=['a','b'].map(id=>({id,roleName:'运维专员',sessionId:`worker-${id}`,task:{taskId:`task-${id}`,title:'检查服务器'}} as SuperWorker));
 const original=JSON.stringify(entries);
 const html=renderToStaticMarkup(createElement(SpecialistChannelEntries,{entries,resources:[],workers}));
 assert.ok(html.includes('已取得磁盘证据')&&html.includes('需要核实原操作'));
 assert.ok(html.includes('data-source-session="worker-a"')&&html.includes('data-task-id="task-b"'));
 assert.equal((html.match(/role="separator"/g)??[]).length,2,'equal task titles still have distinct boundaries; follow-on prose has no extra divider');
 assert.ok(html.includes('data-task-divider="task-a"')&&html.includes('data-task-divider="task-b"'));
 assert.ok(html.includes('这是同一任务的后续说明'));
 assert.equal(JSON.stringify(entries),original);
 assert.ok(!html.includes('执行详情')&&!html.includes('specialist-channel-source'));
});

test('inspector task navigation keeps distinct source sessions even for equal task titles',()=>{
 const worker=(id:string,state:SuperWorker['task']['state']):SuperWorker=>({id,roleId:'ops',roleName:'运维专员',sessionId:`session-${id}`,assignmentState:'active',task:{taskId:`task-${id}`,sessionId:`session-${id}`,title:'检查服务器',state,acceptanceState:'not_evaluated',revision:1,originRootTurnId:`root-${id}`,deadlineAt:''}});
 const a=worker('a','completed'),b=worker('b','paused'),c=worker('c','running'),d=worker('d','waiting_user');
 const entries:SpecialistChannelEntry[]=[{id:'latest',sourceSessionId:b.sessionId,taskId:b.task.taskId,createdAt:'2026-11-04T02:00:00Z'}];
 const ordered=channelTasksByRecentRecord([a,b],entries);
 assert.deepEqual(ordered.map(row=>row.id),['b','a']);
 assert.equal(preferredChannelTask(ordered),b,'idle channel opens the task with the most recent loaded record');
 assert.equal(preferredChannelTask([b,c]),c,'active work is reachable before paused history');
 assert.equal(preferredChannelTask([c,d]),d,'a task needing confirmation is directly reachable');
 assert.equal(preferredChannelTask([]),undefined);
 const html=renderToStaticMarkup(createElement(SpecialistTaskSelect,{workers:[a,b],sessionId:b.sessionId,onTask:()=>{}}));
 assert.ok(html.includes('role="combobox"')&&html.includes('aria-label="查看专员任务"'));
 assert.ok(html.includes('value="session-a"')&&html.includes('value="session-b" selected=""'));
 assert.ok(html.includes('任务记录')&&html.includes('检查服务器'));
 assert.deepEqual([a,b].map(row=>row.id),['a','b'],'display ordering does not mutate task metadata');
});

test('the header task list starts collapsed and reveals source on demand', () => {
 const source = '查看项目的发布记录';
 const html = renderToStaticMarkup(createElement(SpecialistTaskMenu, {sessionId: 'orders-session', currentTaskId: 'orders-task', source, onTask() {}}));
 assert.match(html, /aria-label="专员任务清单"/);
 assert.match(html, /aria-expanded="false"/);
 assert.ok(!html.includes(source));
});
