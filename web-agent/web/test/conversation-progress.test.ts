import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard,SessionSnapshot} from '../../shared/contracts';
import {conversationGroups} from '../src/conversation-progress-model';
import {AITranscript} from '../src/AIPanel';

const at='2026-10-18T08:00:00Z';
const card=(id:string,type:string,status='completed',content=id)=>({id,at,card:{id,at,type,status,content,title:'shell',data:{arguments:{command:'uptime'},target:'测试主机'}}});
const user={id:'user',at,message:{id:'user',role:'user',text:'检查状态',createdAt:at} as SessionSnapshot['messages'][number]};
test('adding a tool appends its own row and never reclassifies the preceding reply',()=>{
 const first=[user,card('first','message','running')];
 const before=conversationGroups(first);
 const later=conversationGroups([...first,card('op1','operation','running'),card('second','message'),card('op2','shell','running')]);
 assert.deepEqual(later.slice(0,before.length),before);
 assert.deepEqual(later.map(g=>[g.progress,g.entries.map(e=>e.id)]),[[false,['user']],[false,['first']],[true,['op1']],[false,['second']],[true,['op2']]]);
});
test('plain answers and scope questions retain their own rows',()=>{
 const question={id:'question',at,message:{...user.message!,role:'assistant',text:'请确认范围'}};
 assert.ok(conversationGroups([card('reply','message'),question]).every(g=>!g.progress));
});
test('operation status changes keep the same row and never absorb preceding text',()=>{
 for(const status of ['running','pending','completed','failed','unknown','interrupted','cancelled','not_executed','background_running']){
  const groups=conversationGroups([card('before','message'),card('tool','operation',status),card('next','message')]);
  assert.deepEqual(groups.map(g=>[g.progress,g.entries.map(e=>e.id)]),[[false,['before']],[true,['tool']],[false,['next']]],status);
 }
 const approval={id:'approval',at,action:{id:'approval'} as SessionSnapshot['actions'][number]};
 assert.deepEqual(conversationGroups([card('one','operation'),approval,user,card('error','error','failed')]).map(g=>g.entries[0]!.id),['one','approval','user','error']);
});
test('child dispatch and SRE entries retain their existing controls',()=>{
 const run={id:'run',at,agentRun:{id:'run'} as NonNullable<Parameters<typeof conversationGroups>[0][number]['agentRun']>};
 const sre={id:'sre',at,sre:{} as NonNullable<Parameters<typeof conversationGroups>[0][number]['sre']>};
 const groups=conversationGroups([card('dispatch','operation'),run,sre,card('reply','message')]);
 assert.ok(groups.every(g=>!g.progress));
 assert.deepEqual(groups[0]!.entries.map(e=>e.id),['dispatch','run']);
});
test('all tool rounds remain visible in order; final reply and duration stay single',()=>{
 const s={session:{id:'s'},messages:[user.message],actions:[],resources:[],replyTimings:[{messageId:user.message!.id,startedAt:at,finishedAt:'2026-10-18T08:01:00Z',status:'completed'}],ai:{session:'s',status:'completed',cardsOffset:0,turns:1,cards:Array.from({length:12},(_,i)=>[card(`note${i}`,'message','completed',`说明 ${i}`).card,card(`tool${i}`,'operation').card]).flat().concat([card('final','message','completed','最终结论').card])}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.ok(html.includes('说明 0')&&html.includes('说明 11')&&html.includes('最终结论'));
 assert.equal((html.match(/data-conversation-entry=/g)||[]).length,25);
 assert.equal((html.match(/class="thinking-timeline /g)||[]).length,12);
 assert.ok(!html.includes('reply-arrival'),'restored rows must not animate');
 assert.equal((html.match(/turn-status-text/g)||[]).length,1);
 const activity=renderToStaticMarkup(createElement(AITranscript,{snapshot:s,mode:'activity'}));
 assert.equal((activity.match(/class="thinking-timeline /g)||[]).length,1);
});

test('consecutive operations on the same resource reuse the first row without mutating entries',()=>{
 const first=card('one','operation'),next=card('two','operation','running');
 const entries=[card('note','message'),first,next];
 const before=conversationGroups(entries.slice(0,2));
 const after=conversationGroups(entries);
 assert.equal(after.length,2);
 assert.equal(after[1]!.entries[0]!.id,before[1]!.entries[0]!.id);
 assert.deepEqual(after[1]!.entries.map(e=>e.id),['one','two']);
 assert.equal(entries.length,3);
 assert.deepEqual(before[1]!.entries.map(e=>e.id),['one']);
 const s={session:{id:'s'},messages:[user.message],actions:[],resources:[],ai:{session:'s',status:'running',cardsOffset:0,turns:1,cards:entries.map(e=>e.card)}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.equal((html.match(/class="thinking-timeline /g)||[]).length,1);
 assert.ok(html.includes('2 项')&&html.includes('data-conversation-entry="one"'));
 assert.ok(!html.includes('data-conversation-entry="two"'));
});
test('resource boundaries and attention states never disappear into a successful group',()=>{
 const one=card('one','operation');
 const different={...card('other','operation'),card:{...one.card,id:'other',data:{...one.card.data,target:'另一主机'}}};
 assert.equal(conversationGroups([one,different]).length,2);
 for(const status of ['pending','failed','unknown','interrupted','cancelled','not_executed','background_running']){
  assert.equal(conversationGroups([one,card('attention','operation',status),card('next','operation')]).length,3,status);
 }
 for(const target of ['', '当前项目/会话','项目资源目录']){
  const unscoped={...one,card:{...one.card,data:{target}}};
  assert.equal(conversationGroups([unscoped,{...unscoped,id:'two'}]).length,2,target);
 }
 const scoped=(id:string,asset:string,terminal='',container='')=>({...card(id,'operation'),card:{...one.card,id,data:{target:'同名资源',arguments:{asset_ref:asset,terminal_id:terminal,container}}}});
 assert.equal(conversationGroups([scoped('a','asset1'),scoped('b','asset2')]).length,2);
 assert.equal(conversationGroups([scoped('a','asset1','t1'),scoped('b','asset1','t2')]).length,2);
 assert.equal(conversationGroups([scoped('a','asset1','','c1'),scoped('b','asset1','','c2')]).length,2);
 assert.equal(conversationGroups([one,card('note','message'),card('next','operation')]).length,3);
 const empty=card('empty','thinking','running','');
 assert.deepEqual(conversationGroups([one,empty,card('next','operation')])[0]!.entries.map(e=>e.id),['one','next']);
});

const sessionOperation=(id:string,title:string,args:Record<string,unknown>={},status='completed')=>({...card(id,'operation',status),card:{...card(id,'operation',status).card,title,data:{target:'当前项目/会话',arguments:args}}});
test('workflow and schedule domains each reuse one row with a stable first key',()=>{
 const before=conversationGroups([sessionOperation('list','list_workflows')]);
 const result=conversationGroups([sessionOperation('list','list_workflows'),sessionOperation('save','save_workflow'),sessionOperation('create','schedule_create'),sessionOperation('check','schedule_list')]);
 assert.deepEqual(result.map(group=>group.entries.map(entry=>entry.id)),[['list','save'],['create','check']]);
 assert.equal(result[0]!.entries[0]!.id,before[0]!.entries[0]!.id);
 assert.equal(before[0]!.entries.length,1,'a later snapshot must not mutate the earlier group');
 const s={session:{id:'s'},messages:[user.message],actions:[],resources:[],ai:{session:'s',status:'completed',cardsOffset:0,turns:1,cards:result.flatMap(group=>group.entries.map(entry=>entry.card))}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.equal((html.match(/class="thinking-timeline /g)||[]).length,2);
 assert.equal((html.match(/2 项/g)||[]).length,2);
});
test('audit all current session tools for explicit family grouping or decision boundaries',()=>{
 const families=[['list_workflows','get_workflow_run','run_workflow','save_workflow'],['schedule_create','schedule_list','schedule_update','schedule_delete'],['todo_read','todo_write'],['load_skill'],['read_session_context'],['read_tool_result'],['task_output','task_stop'],['list_mcp_servers'],['list_mcp_tools','call_mcp_tool']];
 const args={session_id:'history-session',result_id:'result',task_id:'task',server_id:'mcp'};
 const names=[...readFileSync(new URL('../../../internal/ai/extended_catalog.go',import.meta.url),'utf8').matchAll(/^\s*\{"([a-z_]+)", "/gm)].map(match=>match[1]);
 assert.deepEqual([...names].sort(),[...families.flat(),'ask_user_question'].sort(),'new session tools need an explicit grouping/boundary decision');
 for(const family of families){
  const entries=[...family,...family].map((name,i)=>sessionOperation(`op-${i}`,name,args));
  assert.equal(conversationGroups(entries).length,1,family.join(','));
 }
 assert.equal(conversationGroups([sessionOperation('a','list_assets'),sessionOperation('b','list_resource_groups')]).length,1);
});
test('family groups respect attention, prose, user choice and handle boundaries',()=>{
 const list=sessionOperation('list','list_workflows');
 for(const status of ['pending','failed','unknown','interrupted','cancelled','not_executed','background_running']){
  assert.equal(conversationGroups([list,sessionOperation('save','save_workflow',{},status),sessionOperation('next','list_workflows')]).length,3,status);
 }
 for(const middle of [card('note','message'),user,sessionOperation('choice','ask_user_question')]){
  assert.equal(conversationGroups([list,middle,sessionOperation('save','save_workflow')]).length,3);
 }
 for(const [name,key] of [['task_output','task_id'],['read_session_context','session_id'],['read_tool_result','result_id'],['call_mcp_tool','server_id']] as const){
  assert.equal(conversationGroups([sessionOperation('a',name,{[key]:'one'}),sessionOperation('b',name,{[key]:'two'})]).length,2,key);
  assert.equal(conversationGroups([sessionOperation('a',name),sessionOperation('b',name)]).length,2,'missing '+key);
 }
 assert.equal(conversationGroups([sessionOperation('a','future_unknown_tool'),sessionOperation('b','future_unknown_tool')]).length,2);
});
