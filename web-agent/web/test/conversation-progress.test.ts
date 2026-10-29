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
test('conversation keeps history folded and closes its process before presenting an answer',()=>{
 const oldUser={...user.message!,id:'old-user',createdAt:'2026-10-18T07:00:00Z'};
 const oldTool={...card('old-tool','operation').card,at:'2026-10-18T07:00:01Z'};
 const oldReply={...card('old-reply','message').card,at:'2026-10-18T07:00:02Z'};
 for(const status of ['running','waiting_approval','completed','failed','cancelled']){
  const s={session:{id:'s'},messages:[oldUser,user.message],actions:[],resources:[],ai:{session:'s',status,cardsOffset:0,cards:[oldTool,oldReply,card('tool','operation').card,card('reply','message').card]}} as SessionSnapshot;
  const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
  const position=(id:string)=>html.indexOf(`data-conversation-entry="${id}"`);
  assert.ok(position('old-reply')<position('old-tool'),'recorded operations stay below the reply');
  assert.ok(html.includes('class="turn-execution-details" aria-hidden="true" inert=""'),status);
  const current=html.slice(html.indexOf('id="conversation-turn-s-user"'));
  assert.equal(current.includes('class="turn-execution-details is-open"'),status==='waiting_approval',status);
  assert.ok(!current.includes('thinking-steps'),'resource operations stay folded until requested');
  assert.ok(html.indexOf('aria-label="执行详细过程"')<position('tool'));
  assert.ok(position('reply')<position('tool'),'the gray process stays beneath the visible reply');
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
 assert.ok(!renderToStaticMarkup(createElement(AITranscript,{snapshot:noTiming})).includes('已停止本轮'),'stop notices stay out of prose even without saved timing');
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


test('recorded process remains available while generated prose retires the live status line',()=>{
 const entries=[user,card('tool','operation'),card('stream','message','running','正在汇总结果。')];
 assert.equal(currentProgressGroupId(entries,true),'tool');
 assert.equal(currentProgressGroupId(entries,false),undefined);
 const s={session:{id:'s'},messages:[user.message],actions:[],resources:[],ai:{session:'s',status:'running',cardsOffset:0,turns:1,cards:entries.flatMap(e=>e.card?[e.card]:[])}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.ok(html.includes('is-continuing'));
 assert.ok(html.includes('is-preview')&&!html.includes('reply-duration-spinner'),'elapsed preview precedes the reply without a trailing live status');
 assert.ok(html.indexOf('class="reply-duration ')<html.indexOf('正在汇总结果。'));
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
 const bodyStart=html.indexOf('class="turn-execution-details"'),replyEnd=html.indexOf('data-conversation-entry="reply"');
 assert.ok(replyEnd<bodyStart,'final reply remains above the elapsed line and process disclosure');
 assert.ok(html.slice(bodyStart).includes('执行失败'),'recorded tool summary remains inside the hidden process body');
 assert.ok(html.slice(replyEnd,bodyStart).includes('最终结果仍然可见'));
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
 assert.ok(html.includes('data-kind="database"')&&html.includes('resource-kind-icon kind-database'));
 assert.ok(html.includes('Mini Box SSH 命令终端'),'the host command preview is visible in its dispatch render');
 assert.ok(!html.includes('thinking-tool-detail'),'original payloads remain lazy');
});

test('opaque legacy aliases recover only a unique exact catalog target; recorded IDs win',()=>{
 const resources=[{id:'pg',name:'数据库',kind:'database'},{id:'cluster',name:'集群',kind:'kubernetes'}] as Resource[];
 const operation=(data:Record<string,unknown>)=>({...card('op','operation'),card:{...card('op','operation').card,data}});
 const legacy=operation({target:'数据库',arguments:{asset_ref:'a_0123456789abcdef'}});
 assert.deepEqual(conversationGroups([legacy],resources)[0]!.resource,{id:'pg',name:'数据库',kind:'database'});
 const explicit=operation({resource_id:'cluster',target:'数据库',arguments:{asset_ref:'a_0123456789abcdef'}});
 assert.equal(conversationGroups([explicit],resources)[0]!.resource?.kind,'kubernetes');
 const ambiguous=[...resources,{id:'other',name:'数据库',kind:'ssh'}] as Resource[];
 assert.equal(conversationGroups([legacy],ambiguous)[0]!.resource?.kind,undefined);
 const missing=operation({resource_id:'removed',target:'数据库'});
 assert.equal(conversationGroups([missing],resources)[0]!.resource?.kind,undefined,'missing recorded ID must not borrow another resource');
});


test('background failures and handle reads stay beneath the dispatch resource, not a later context target',()=>{
 const resources=[{id:'a',name:'主机 A',kind:'ssh'},{id:'b',name:'主机 B',kind:'ssh'}] as Resource[];
 const dispatch=(id:string,rid:string,job:string)=>({...card(id,'operation'),card:{...card(id,'operation').card,data:{resource_id:rid,target:'主机 '+rid.toUpperCase()},content:JSON.stringify({shell_id:job,terminal_id:'terminal-'+rid,entry_id:'entry-'+id})}});
 const failed={...card('job-b','shell','failed','原命令等待失败，结果未确认'),card:{...card('job-b','shell','failed','原命令等待失败，结果未确认').card,title:'后台命令',data:undefined}};
 const follow={...card('read-job-b','operation'),card:{...card('read-job-b','operation').card,title:'shell_output',data:{resource_id:'a',target:'主机 A',arguments:{shell_id:'job-b'}},content:JSON.stringify({shell_id:'job-b',status:'failed'})}};
 const entries=[dispatch('dispatch-a','a','job-a'),dispatch('dispatch-b','b','job-b'),failed,follow];
 const groups=conversationGroups(entries,resources);
 assert.deepEqual(groups.map(g=>[g.resource?.id,g.entries.map(e=>e.id)]),[['a',['dispatch-a']],['b',['dispatch-b','job-b','read-job-b']]]);
 assert.equal(follow.card.data.resource_id,'a','view projection must not rewrite the saved payload');
 const snapshot={session:{id:'s'},messages:[user.message],actions:[],resources,ai:{session:'s',status:'running',cardsOffset:0,cards:entries.map(e=>e.card)}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
 assert.equal((html.match(/class="thinking-timeline /g)||[]).length,2,'no orphan generic execution rows');
 assert.ok(html.includes('主机 B · 1 项执行失败'));
 assert.equal(groups[1]!.entries.find(e=>e.id==='job-b')?.card?.content,'原命令等待失败，结果未确认','raw failure stays in its resource disclosure');
 // A new user turn may read the same exact old handle, but does not move the
 // background job out of the turn where it was launched.
 const later=conversationGroups([...entries,user,{...follow,id:'later-read'}],resources);
 assert.deepEqual(later.at(-1)?.entries.map(e=>e.id),['later-read']);
 assert.equal(later.at(-1)?.resource?.id,'b');
 const liveDisplay=conversationDisplayGroups([...entries,user,{...follow,id:'later-read'}],true,resources);
 assert.equal(liveDisplay.at(-1)?.resource?.id,'b','live presentation retains exact ownership across turns');
 const persisted={...failed,card:{...failed.card,data:{resource_id:'b',target:'主机 B',shell_id:'job-b'}}};
 const pruned=conversationGroups([persisted,follow],resources);
 assert.equal(pruned.length,1,'recorded background identity survives a pruned dispatch card');
 assert.equal(pruned[0]?.resource?.id,'b');
 const missing=conversationGroups([dispatch('unrelated','a','other'),failed],resources);
 assert.equal(missing[1]?.resource,undefined,'nearby resource cannot guess an unknown job owner');
 const conflict=conversationGroups([dispatch('one','a','job-b'),dispatch('two','b','job-b'),failed],resources);
 assert.equal(conflict.at(-1)?.resource,undefined,'conflicting handle owners stay explicit and unassigned');
});

test('routine interruption notices leave main prose while raw records and unrelated failures remain',()=>{
 const gap='本步骤仍有未完成的只读检查，尚未通过验收。已保留取得的证据，可继续检查或结束任务。';
 const s={session:{id:'s'},messages:[user.message,{id:'system-gap',role:'system',text:gap,createdAt:at}],actions:[],resources:[],ai:{session:'s',status:'failed',cardsOffset:0,cards:[card('gap','error','failed',gap).card,card('failure','error','failed','服务器连接失败').card]}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:s}));
 assert.ok(!html.includes(gap));
 assert.ok(html.includes('服务器连接失败'));
 assert.ok(renderToStaticMarkup(createElement(AITranscript,{snapshot:s,mode:'activity'})).includes(gap),'execution records preserve the actual failure');
 const assistant={...s,messages:[user.message,{id:'quoted',role:'assistant',text:gap,createdAt:at}],ai:{...s.ai!,cards:[]}};
 assert.ok(renderToStaticMarkup(createElement(AITranscript,{snapshot:assistant})).includes(gap),'assistant prose is never filtered by lifecycle wording');
});
