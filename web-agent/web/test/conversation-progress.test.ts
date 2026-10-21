import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard,Resource,SessionSnapshot} from '../../shared/contracts';
import {conversationDisplayGroups,conversationGroups,currentProgressGroupId} from '../src/conversation-progress-model';
import {AITranscript} from '../src/AIPanel';

const at='2026-10-18T08:00:00Z';
const card=(id:string,type:string,status='completed',content=id)=>({id,at,card:{id,at,type,status,content,title:'shell',data:{arguments:{command:'uptime'},target:'测试主机'}}});
const user={id:'user',at,message:{id:'user',role:'user',text:'检查状态',createdAt:at} as SessionSnapshot['messages'][number]};
test('adding a tool appends its own row and never reclassifies the preceding reply',()=>{
 const first=[user,card('first','message','running')];
 const before=conversationGroups(first);
 const later=conversationGroups([...first,card('op1','operation','running'),card('second','message'),card('op2','shell','running')]);
 assert.deepEqual(later.slice(0,before.length),before);
 assert.deepEqual(later.map(g=>[g.progress,g.entries.map(e=>e.id)]),[[false,['user']],[false,['first']],[true,['op1','op2']],[false,['second']]]);
});
test('plain answers and scope questions retain their own rows',()=>{
 const question={id:'question',at,message:{...user.message!,role:'assistant',text:'请确认范围'}};
 assert.ok(conversationGroups([card('reply','message'),question]).every(g=>!g.progress));
});
test('active prose stays above all progress rows without changing row keys or raw chronology',()=>{
 const first=sessionOperation('workflow','list_workflows');
 const entries=[user,first,card('note','message'),sessionOperation('schedule','schedule_create'),card('stream','text','running'),sessionOperation('saved','save_workflow')];
 const chronological=conversationGroups(entries);
 const display=conversationDisplayGroups(entries,true);
 assert.deepEqual(display.map(group=>group.entries[0]!.id),['user','note','stream','workflow','schedule']);
 assert.deepEqual(display.find(group=>group.entries[0]!.id==='workflow')!.entries.map(entry=>entry.id),['workflow','saved']);
 assert.deepEqual(conversationGroups(entries),chronological,'presentation must not mutate the source');
 assert.deepEqual(conversationDisplayGroups(entries,false),chronological,'completed history retains its timeline');
 const nextUser={...user,id:'next-user',message:{...user.message!,id:'next-user'}};
 assert.deepEqual(conversationDisplayGroups([...entries,nextUser,card('other-tool','operation'),card('other-note','message')],true).map(group=>group.entries[0]!.id),['user','note','stream','workflow','schedule','next-user','other-note','other-tool']);
});
test('active presentation preserves approvals, errors, questions and child controls',()=>{
 const approval={id:'approval',at,action:{id:'approval'} as SessionSnapshot['actions'][number]};
 const run={id:'run',at,agentRun:{id:'run'} as NonNullable<Parameters<typeof conversationGroups>[0][number]['agentRun']>};
 const entries=[card('tool','operation','pending'),approval,card('error','error','failed'),sessionOperation('question','ask_user_question'),run,card('reply','message')];
 const before=conversationGroups(entries),after=conversationDisplayGroups(entries,true);
 assert.deepEqual(after.filter(group=>group.entries[0]!.id!=='reply'),before.filter(group=>group.entries[0]!.id!=='reply'));
 assert.equal(after[0]!.entries[0]!.id,'reply');
});
test('conversation opens the current live process and keeps historical records collapsed',()=>{
 const oldUser={...user.message!,id:'old-user',createdAt:'2026-10-18T07:00:00Z'};
 const oldTool={...card('old-tool','operation').card,at:'2026-10-18T07:00:01Z'};
 const oldReply={...card('old-reply','message').card,at:'2026-10-18T07:00:02Z'};
 for(const status of ['running','waiting_approval','completed','failed','cancelled']){
  const s={session:{id:'s'},messages:[oldUser,user.message],actions:[],resources:[],ai:{session:'s',status,cardsOffset:0,cards:[oldTool,oldReply,card('tool','operation').card,card('reply','message').card]}} as SessionSnapshot;
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
  const position=(id:string)=>html.indexOf(`data-conversation-entry="${id}"`);
  assert.ok(position('old-tool')<position('old-reply'),'historical order stays unchanged');
  assert.ok(html.includes('class="turn-execution-details" aria-hidden="true" inert=""'),status);
  const current=html.slice(html.indexOf('id="conversation-turn-s-user"'));
  assert.equal(current.includes('class="turn-execution-details is-open"'),['running','waiting_approval'].includes(status),status);
  assert.ok(!current.includes('thinking-steps'),'resource operations stay folded until requested');
  assert.ok(html.indexOf('aria-label="执行详细过程"')<position('tool'));
  assert.ok(position('tool')<position('reply'),'the visible reply remains outside the hidden process body');
  const activity=renderToStaticMarkup(createElement(AITranscript,{snapshot:s,mode:'activity'}));
  assert.ok(!activity.includes('data-conversation-entry="reply"'),'activity mode keeps its own projection');
 }
});
test('stopped turns show one neutral status without hiding actual errors or activity records',()=>{
 const s={session:{id:'s'},messages:[user.message],actions:[],resources:[],replyTimings:[{messageId:'user',startedAt:at,finishedAt:'2026-10-18T08:00:04Z',status:'cancelled'}],ai:{session:'s',status:'cancelled',cardsOffset:0,cards:[card('stop','error','cancelled','context canceled').card,card('failure','error','failed','连接已中断，请检查网络').card]}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.ok(html.includes('已停止')&&html.includes('4秒'));
 assert.ok(!html.includes('已停止本轮'));
 assert.ok(!html.includes('data-conversation-entry="stop"'));
 assert.ok(html.includes('连接已中断，请检查网络'));
 const activity=renderToStaticMarkup(createElement(AITranscript,{snapshot:s,mode:'activity'}));
 assert.ok(activity.includes('data-conversation-entry="stop"'),'raw stop record remains in the activity view');
 const noTiming={...s,replyTimings:[]};
 assert.ok(renderToStaticMarkup(createElement(AITranscript,{snapshot:noTiming})).includes('已停止本轮'),'do not remove the only stop notice if timing is unavailable');
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
test('all prose stays visible while one resource row retains all tool rounds',()=>{
 const s={session:{id:'s'},messages:[user.message],actions:[],resources:[],replyTimings:[{messageId:user.message!.id,startedAt:at,finishedAt:'2026-10-18T08:01:00Z',status:'completed'}],ai:{session:'s',status:'completed',cardsOffset:0,turns:1,cards:Array.from({length:12},(_,i)=>[card(`note${i}`,'message','completed',`说明 ${i}`).card,card(`tool${i}`,'operation').card]).flat().concat([card('final','message','completed','最终结论').card])}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.ok(html.includes('说明 0')&&html.includes('说明 11')&&html.includes('最终结论'));
 assert.equal((html.match(/data-conversation-entry=/g)||[]).length,14);
 assert.equal((html.match(/class="thinking-timeline /g)||[]).length,1);
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
test('nonempty reasoning between resource operations stays in one stable progress row',()=>{
 const first=card('thinking-0','thinking','running','先检查主机。');
 const one=card('one','operation'),two=card('two','operation','running');
 const reasoning=card('thinking-1','thinking','running','继续核对进程与连接。');
 const entries=[first,one,reasoning,two];
 for(let size=1;size<=entries.length;size++){
  const groups=conversationGroups(entries.slice(0,size));
  assert.equal(groups.length,1);
  assert.equal(groups[0]!.progress,true);
  assert.deepEqual(groups[0]!.entries.map(e=>e.id),entries.slice(0,size).map(e=>e.id));
  assert.equal(currentProgressGroupId(entries.slice(0,size),true),'thinking-0');
 }
 const completed=entries.map(e=>({...e,card:{...e.card!,status:'completed'}}));
 assert.deepEqual(conversationGroups(completed).map(g=>g.entries.map(e=>e.id)),[['thinking-0','one','thinking-1','two']]);
 assert.equal(currentProgressGroupId(completed,false),undefined);
 const s={session:{id:'s'},messages:[user.message],actions:[],resources:[],ai:{session:'s',status:'running',cardsOffset:0,turns:1,cards:entries.map(e=>e.card)}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.equal((html.match(/class="thinking-timeline /g)||[]).length,1);
 assert.ok(html.includes('2 项')&&html.includes('data-conversation-entry="thinking-0"'));
 assert.ok(!html.includes('分析问题'),'an operation replaces the generic label in the same row');
 assert.ok(html.includes('is-continuing')&&html.includes('is-executing'));
 const activity=renderToStaticMarkup(createElement(AITranscript,{snapshot:s,mode:'activity'}));
 assert.equal((activity.match(/class="thinking-timeline /g)||[]).length,1);
});
test('reasoning bridges workflow and schedule operations without merging domains',()=>{
 const steps=[sessionOperation('list','list_workflows'),card('think-1','thinking'),sessionOperation('save','save_workflow'),card('think-2','thinking'),sessionOperation('create','schedule_create'),card('think-3','thinking'),sessionOperation('check','schedule_list')];
 assert.deepEqual(conversationGroups(steps).map(g=>g.entries.map(e=>e.id)),[['list','think-1','save','think-2'],['create','think-3','check']]);
});
test('one resource row survives narration, other resources, errors and approvals',()=>{
 const one=card('one','operation'),think=card('reasoning','thinking');
 const other={...card('other','operation'),card:{...one.card,id:'other',data:{target:'另一主机'}}};
 const approval={id:'approval',at,action:{id:'approval'} as SessionSnapshot['actions'][number]};
 const entries=[one,think,card('note','message'),other,approval,card('error','error','failed'),card('again','thinking'),card('two','operation','running')];
 const groups=conversationGroups(entries);
 assert.deepEqual(groups.map(g=>g.entries.map(e=>e.id)),[['one','reasoning','two'],['note'],['other','again'],['approval'],['error']]);
 assert.equal(currentProgressGroupId(entries,true),'one','the active row need not be last in display order');
 const nextUser={...user,id:'next-user',message:{...user.message!,id:'next-user'}};
 assert.deepEqual(conversationGroups([one,nextUser,card('two','operation')]).map(g=>g.entries.map(e=>e.id)),[['one'],['next-user'],['two']]);
});
test('resource identities stay separate while all statuses and subtargets share their resource row',()=>{
 const one=card('one','operation');
 const different={...card('other','operation'),card:{...one.card,id:'other',data:{...one.card.data,target:'另一主机'}}};
 assert.equal(conversationGroups([one,different]).length,2);
 for(const status of ['pending','failed','unknown','interrupted','cancelled','not_executed','background_running']){
  assert.deepEqual(conversationGroups([one,card('attention','operation',status),card('next','operation')])[0]!.entries.map(e=>e.id),['one','attention','next'],status);
 }
 for(const target of ['', '当前项目/会话','项目资源目录']){
  const unscoped={...one,card:{...one.card,data:{target}}};
  assert.equal(conversationGroups([unscoped,{...unscoped,id:'two'}]).length,2,target);
 }
 const scoped=(id:string,asset:string,terminal='',container='')=>({...card(id,'operation'),card:{...one.card,id,data:{target:'同名资源',arguments:{asset_ref:asset,terminal_id:terminal,container}}}});
 assert.equal(conversationGroups([scoped('a','asset1'),scoped('b','asset2')]).length,2);
 assert.equal(conversationGroups([scoped('a','asset1','t1'),scoped('b','asset1','t2')]).length,1);
 assert.equal(conversationGroups([scoped('a','asset1','','c1'),scoped('b','asset1','','c2')]).length,1);
 assert.equal(conversationGroups([one,card('note','message'),card('next','operation')]).length,2);
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
test('family groups survive attention and prose but retain user turns, questions and handle identity',()=>{
 const list=sessionOperation('list','list_workflows');
 for(const status of ['pending','failed','unknown','interrupted','cancelled','not_executed','background_running']){
  assert.equal(conversationGroups([list,sessionOperation('save','save_workflow',{},status),sessionOperation('next','list_workflows')]).length,1,status);
 }
 for(const middle of [card('note','message'),user,sessionOperation('choice','ask_user_question')]){
  assert.equal(conversationGroups([list,middle,sessionOperation('save','save_workflow')]).length,middle===user?3:2);
 }
 for(const [name,key] of [['task_output','task_id'],['read_session_context','session_id'],['read_tool_result','result_id'],['call_mcp_tool','server_id']] as const){
  assert.equal(conversationGroups([sessionOperation('a',name,{[key]:'one'}),sessionOperation('b',name,{[key]:'two'})]).length,2,key);
  assert.equal(conversationGroups([sessionOperation('a',name),sessionOperation('b',name)]).length,2,'missing '+key);
 }
 assert.equal(conversationGroups([sessionOperation('a','future_unknown_tool'),sessionOperation('b','future_unknown_tool')]).length,2);
});

test('explicit and context-selected calls share a row only for an unambiguous recorded target',()=>{
 const explicit=(id:string,ref:string)=>({...card(id,'operation'),card:{...card(id,'operation').card,data:{target:'测试主机',arguments:{asset_ref:ref}}}});
 assert.equal(conversationGroups([card('context','operation'),explicit('ref','asset-1'),card('context-2','operation')]).length,1);
 assert.equal(conversationGroups([explicit('a','asset-1'),explicit('b','asset-2')]).length,2,'same names do not merge different resource identities');
 assert.equal(conversationGroups([card('context','operation'),explicit('a','asset-1'),explicit('b','asset-2')]).length,3,'ambiguous context is not assigned to a guessed resource');
});
test('mixed-status resource summaries keep every exceptional result visible',()=>{
 const entries=['completed','failed','pending','unknown','not_executed','cancelled','background_running','running'].map((status,i)=>card(`tool-${i}`,'operation',status));
 const s={session:{id:'s'},messages:[user.message],actions:[],resources:[],ai:{session:'s',status:'running',cardsOffset:0,turns:1,cards:entries.map(e=>e.card)}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.equal((html.match(/class="thinking-timeline /g)||[]).length,1);
 for(const label of ['等待确认','执行失败','结果待核查','未执行','已停止','后台执行中','8 项'])assert.ok(html.includes(label),label);
 assert.ok(!html.includes('is-executing'),'unresolved confirmation and unknown outcomes remain visible and static');
});


test('current normal progress keeps sweeping through generated prose until the turn finishes',()=>{
 const entries=[user,card('tool','operation'),card('stream','message','running','正在汇总结果。')];
 assert.equal(currentProgressGroupId(entries,true),'tool');
 assert.equal(currentProgressGroupId(entries,false),undefined);
 const s={session:{id:'s'},messages:[user.message],actions:[],resources:[],ai:{session:'s',status:'running',cardsOffset:0,turns:1,cards:entries.flatMap(e=>e.card?[e.card]:[])}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.ok(html.includes('is-continuing'));
 assert.ok(html.includes('status-text--active'),'the live status line also sweeps');
 const done=renderToStaticMarkup(createElement(AITranscript,{snapshot:{...s,ai:{...s.ai!,status:'completed'}}}));
 assert.ok(!done.includes('is-continuing')&&!done.includes('status-text--active'));
 for(const status of ['failed','pending','unknown','not_executed','interrupted','cancelled','background_running']){
  const cards=[card('old','operation',status).card,card('new','operation','completed').card,card('stream','message','running').card];
  const blocked=renderToStaticMarkup(createElement(AITranscript,{snapshot:{...s,ai:{...s.ai!,cards}}}));
  assert.ok(!blocked.includes('is-continuing')&&!blocked.includes('is-executing'),status);
 }
});


test('collapsed process retains commands and alerts without hiding prose or pending decision controls',()=>{
 const s={session:{id:'s'},messages:[user.message],actions:[],resources:[],replyTimings:[{messageId:user.message!.id,startedAt:at,finishedAt:'2026-10-18T08:09:54Z',status:'completed'}],ai:{session:'s',status:'completed',cardsOffset:0,cards:[card('tool','operation','failed').card,card('reply','message','completed','最终结果仍然可见').card]}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.ok(html.includes('用时 9分钟 54秒')&&html.includes('1 项失败'));
 assert.ok(html.includes('aria-expanded="false"')&&html.includes('执行详细过程'));
 const bodyStart=html.indexOf('class="turn-execution-details"'),bodyEnd=html.indexOf('data-conversation-entry="reply"');
 assert.ok(html.slice(bodyStart,bodyEnd).includes('执行失败'),'recorded tool summary remains inside the hidden process body');
 assert.ok(html.slice(bodyEnd).includes('最终结果仍然可见'));
});


test('catalog identity joins different actions into one resource row and never merges same-name IDs',()=>{
 const resources=[{id:'host-a',name:'演示节点',kind:'ssh'},{id:'db-b',name:'演示数据库',kind:'database'}] as Resource[];
 const scoped=(id:string,title:string,target:string,ref?:string)=>({...card(id,'operation'),card:{...card(id,'operation').card,title,data:{target,arguments:ref?{asset_ref:ref}:{}}}});
 const entries=[scoped('shell','shell','演示节点','host-a'),scoped('query','execute_sql','演示数据库','db-b'),scoped('read','read','host-a'),scoped('handle','task_output','演示节点','host-a')];
 const rows=conversationGroups(entries,resources);
 assert.deepEqual(rows.map(row=>[row.resource?.name,row.entries.map(entry=>entry.id)]),[['演示节点',['shell','read','handle']],['演示数据库',['query']]]);
 assert.equal(rows[0]!.resource?.kind,'ssh');
 assert.equal(currentProgressGroupId(entries,true,resources),'shell');
 assert.equal(conversationGroups([scoped('a','shell','同名','a'),scoped('b','read','同名','b')],[{id:'a',name:'同名'},{id:'b',name:'同名'}] as Resource[]).length,2);
 const snapshot={session:{id:'s'},messages:[user.message],actions:[],resources,ai:{session:'s',status:'running',cardsOffset:0,cards:entries.map(entry=>entry.card)}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
 assert.equal((html.match(/class="thinking-timeline /g)||[]).length,2);
 assert.ok(html.includes('<span class="thinking-label">演示节点</span>'));
 assert.ok(html.includes('data-glyph="lakeDatabase"'));
 assert.ok(!html.includes('thinking-tool-detail')&&!html.includes('thinking-steps'),'resource children and payloads are lazy');
});
