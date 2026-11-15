import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Message,GatewayMessage,GatewayInstructionTask,SessionSnapshot} from '../../shared/contracts';
import {TranscriptMessage} from '../src/AIPanel';
import {GatewaySettings,GatewayMessageTree,GatewayMessageList,gatewayCommandSnippet,gatewayClientConfig,gatewayDeliveryText,gatewayTaskMatches,gatewayTaskTarget,readGatewayMessagePages} from '../src/GatewaySettings';
import {SpecialistTaskList} from '../src/SpecialistTaskList';

const base:Message={id:'m1',sessionId:'channel',role:'user',text:'检查生产数据库磁盘',createdAt:'2026-11-14T00:00:00Z'};

test('external MCP instructions carry a visible origin badge; ordinary user messages do not',()=>{
  const external=renderToStaticMarkup(createElement(TranscriptMessage,{sessionId:'channel',message:{...base,external:{kind:'mcp'}}}));
  assert.match(external,/external-origin-badge/);assert.match(external,/外部 Agent/);assert.match(external,/检查生产数据库磁盘/);
  const ordinary=renderToStaticMarkup(createElement(TranscriptMessage,{sessionId:'channel',message:base}));
  assert.doesNotMatch(ordinary,/external-origin-badge/);assert.match(ordinary,/检查生产数据库磁盘/);
  const assistant:Message={id:'m2',sessionId:'channel',role:'assistant',text:'磁盘使用率 42%。',createdAt:'2026-11-14T00:00:05Z',external:{kind:'mcp'}};
  const reply=renderToStaticMarkup(createElement(TranscriptMessage,{sessionId:'channel',message:assistant}));
  assert.doesNotMatch(reply,/external-origin-badge/),'only external instructions (user role) show the badge';
});

test('gateway settings render their loading shell without a server connection',()=>{
  const html=renderToStaticMarkup(createElement(GatewaySettings,{onBusyChange:()=>{}}));
  assert.match(html,/我的连接/);assert.match(html,/正在读取接入渠道…/);assert.doesNotMatch(html,/每个专员一个/);
});

test('copied MCP commands retain a custom data path for packaged and script installs',()=>{
  const packaged={program:'/Applications/Lake Dev.app/Contents/Resources/lake',home:'/tmp/dev-home',data:'/tmp/custom web data'};
  for(const command of [packaged,{...packaged,program:'/opt/node/bin/node',script:'/tmp/lake server.cjs'}]){
    const snippet=gatewayCommandSnippet(command,'token-id','role_dba');
    assert.match(snippet,/--home \/tmp\/dev-home --data "\/tmp\/custom web data" --role role_dba --token-id token-id$/);
  }
  assert.doesNotMatch(gatewayCommandSnippet({program:'lake',home:'/tmp/legacy'},'token-id'),/--data/,'older servers keep the default data layout');
});

test('task rows mark work that arrived from an external agent',()=>{
  const worker:import('../../shared/contracts').SuperWorker={id:'w1',roleId:'r',roleName:'数据库专员',sessionId:'sw1',sourceExternal:true,
    task:{taskId:'st1',sessionId:'sw1',title:'检查本机当前时间与磁盘剩余空间',state:'completed',acceptanceState:'pass',revision:1,originRootTurnId:'t1',deadlineAt:'2026-11-14T01:30:00Z'},assignmentState:'parked'};
  const list=renderToStaticMarkup(createElement(SpecialistTaskList,{channel:{id:'c',sessionId:'sc',projectId:'p',roleId:'r',roleName:'数据库专员',revision:1,createdAt:'2026-11-14T00:00:00Z'},rows:[{worker,progress:null,agent:'Lake Worker',members:[],moving:false,updatedAt:'2026-11-14T00:10:00Z'}],connected:false,onTask:()=>{}}));
  assert.match(list,/external-origin-badge/);assert.match(list,/外部 Agent/);
});


const task=(id:string,state='running'):GatewayInstructionTask=>({taskId:id,title:`任务 ${id}`,sessionId:`session-${id}`,roleId:`role-${id}`,roleName:`专员 ${id}`,state:state==='completed'?'parked':'active',goalState:state});
const source=(id='message-1'):GatewayMessage=>({instructionId:id,eventId:`event-${id}`,sessionId:'pilot',projectId:'project-1',connectionId:'connection-1',threadId:'thread-1',threadTitle:'发布前检查',text:'检查服务健康，并核对发布记录',createdAt:'2026-11-15T02:42:00Z',state:'running',disposition:'routed',tasks:[task('health','completed'),task('release')],replies:[{taskId:'health',text:'健康报告',createdAt:'2026-11-15T02:43:00Z',from:'specialist'}]});

test('message history defaults to the latest source and keeps all its tasks, while expansion and refresh preserve real history',()=>{
 const latest={...source('latest'),text:'最近收到的请求'},older={...source('older'),text:'较早收到的请求',tasks:[task('older-task')]};
 const messages=[latest,older];
 const render=(rows:GatewayMessage[],expanded?:boolean)=>renderToStaticMarkup(createElement(GatewayMessageList,{messages:rows,expanded,connectionName:'我的 Codex',onTask:()=>{}}));
 const collapsed=render(messages);
 assert.match(collapsed,/最近收到的请求/);assert.doesNotMatch(collapsed,/较早收到的请求/);
 assert.match(collapsed,/查看任务：任务 health/);assert.match(collapsed,/查看任务：任务 release/);
 const expanded=render(messages,true);
 assert.match(expanded,/最近收到的请求/);assert.match(expanded,/较早收到的请求/);assert.match(expanded,/查看任务：任务 older-task/);
 const refreshed=[{...source('incoming'),text:'轮询收到的新请求'},...messages];
 assert.match(render(refreshed),/轮询收到的新请求/);assert.doesNotMatch(render(refreshed),/最近收到的请求|较早收到的请求/);
 assert.match(render(refreshed,true),/较早收到的请求/);
 assert.equal(messages.length,2,'collapsing does not remove older messages or their task identities');
});

test('a source message exposes every related task with exact identity and partial report progress',()=>{
 const message=source();
 const html=renderToStaticMarkup(createElement(GatewayMessageTree,{message,connectionName:'我的 Codex',onTask:()=>{}}));
 assert.match(html,/发布前检查/);assert.match(html,/Pilot 已关联 2 项任务/);
 assert.match(html,/查看任务：任务 health/);assert.match(html,/查看任务：任务 release/);
 assert.match(html,/专员 health/);assert.match(html,/专员 release/);
 assert.match(html,/已收到 1 \/ 2 份报告 · 仍在处理/);assert.doesNotMatch(html,/汇总后回复|全部完成|验收通过/);
 assert.deepEqual(gatewayTaskTarget(message,message.tasks[1]),{projectId:'project-1',sessionId:'session-release',taskId:'release',roleId:'role-release'});
 assert.equal(gatewayTaskTarget(message,{...message.tasks[1]}),undefined,'foreign task object cannot be navigated from this message');
 const missing={...message,tasks:[{...message.tasks[0],sessionId:undefined}]};
 assert.equal(gatewayTaskTarget(missing,missing.tasks[0]),undefined);
 assert.match(renderToStaticMarkup(createElement(GatewayMessageTree,{message:missing,connectionName:'我的 Codex',onTask:()=>{}})),/disabled="" aria-label="查看任务：任务 health"/);
});

test('delivery projection does not mistake partial reports or cancelled task notices for all task results',()=>{
 const message=source();
 message.replies.push({...message.replies[0]}, {from:'pilot',text:'已派单',createdAt:message.createdAt},{from:'specialist',taskId:'foreign',text:'别的任务',createdAt:message.createdAt});
 assert.equal(gatewayDeliveryText(message),'已收到 1 / 2 份报告 · 仍在处理');
 message.tasks[1].goalState='cancelled';message.state='stopped';
 message.replies.push({from:'specialist',taskId:'release',text:'已停止',createdAt:message.createdAt});
 assert.equal(gatewayDeliveryText(message),'已收到 1 / 2 份报告 · 本次处理已停止');
 const question={...source(),tasks:[],replies:[],state:'waiting_input' as const};
 assert.equal(gatewayDeliveryText(question),'等待补充信息');
});

test('MCP client JSON preserves executable arguments without shell expansion and includes the custom data directory',()=>{
 const command={program:'/Applications/Lake Dev.app/lake',script:'/tmp/a "quoted" $script.cjs',home:'/tmp/dev home',data:'/tmp/web data'};
 const configuration=JSON.parse(gatewayClientConfig(command,{id:'connection-1'}));
 assert.deepEqual(configuration.mcpServers['lake-connection-1'],{command:command.program,args:[command.script,'--mcp-channel','--home',command.home,'--data',command.data,'--connection','connection-1']});
 const packaged=JSON.parse(gatewayClientConfig({program:'/lake',home:'/isolated'}, {id:'packaged'}));
 assert.deepEqual(packaged.mcpServers['lake-packaged'].args,['--mcp-channel','--home','/isolated','--connection','packaged']);
 assert.doesNotMatch(JSON.stringify(configuration),/--role|--token-id|lkgw_/);
});

test('task navigation accepts an exact shared-task execution and rejects different projects, roles and goals',()=>{
 const target={projectId:'p',sessionId:'s',taskId:'execution-1',roleId:'r'};
 const snapshot={session:{id:'s',projectId:'p'},superagent:{roleId:'r',task:{taskId:'shared-task',executionGoalId:'execution-1',sessionId:'s'}}} as SessionSnapshot;
 assert.equal(gatewayTaskMatches(snapshot,target),true);
 for(const wrong of [{projectId:'other'},{sessionId:'other'},{roleId:'other'},{taskId:'other'}])assert.equal(gatewayTaskMatches(snapshot,{...target,...wrong}),false);
 const inline={session:{id:'pilot',projectId:'p'},superagent:{roleId:'pilot:p',task:{taskId:'inline-goal',sessionId:'pilot'}}} as SessionSnapshot;
 assert.equal(gatewayTaskMatches(inline,{projectId:'p',sessionId:'pilot',taskId:'inline-goal',roleId:'pilot:p'}),true);
});

test('refreshing loaded history deduplicates moving page boundaries and retains the newest task progress',async()=>{
 const latest=source('new'),boundary=source('boundary'),old={...source('boundary'),state:'routing' as const};
 const cursors:Array<string|undefined>=[];
 const result=await readGatewayMessagePages(async cursor=>{cursors.push(cursor);return cursor?{messages:[old,source('old')]}:{messages:[latest,boundary],nextCursor:'page-2'};},2,new AbortController().signal);
 assert.deepEqual(cursors,[undefined,'page-2']);
 assert.deepEqual(result.messages.map(message=>message.instructionId),['new','boundary','old']);
 assert.equal(result.messages[1].state,'running');assert.equal(result.nextCursor,undefined);
});

test('switching connections while a history request is in flight discards the late response',async()=>{
 const cancel=new AbortController();let resolve!:(value:{messages:GatewayMessage[];nextCursor:string})=>void;let calls=0;
 const pending=readGatewayMessagePages(()=>{calls++;return new Promise(done=>{resolve=done;});},2,cancel.signal);
 cancel.abort();resolve({messages:[source()],nextCursor:'old-connection-page-2'});
 await assert.rejects(pending,error=>(error as Error).name==='AbortError');assert.equal(calls,1,'must not follow stale history cursor after connection switch');
});

test('connection API mutations carry scope, revision and encoded identities without sending credentials',async t=>{
 const {api}=await import('../src/api');const calls:Array<{url:string;init?:RequestInit}>=[];
 t.mock.method(globalThis,'fetch',async(url:string,init?:RequestInit)=>{calls.push({url,init});return Response.json({});});
 await api.createGatewayConnection({name:'Codex',projectId:'project-1',routing:{mode:'pilot'}});
 await api.updateGatewayConnection('connection/1',{enabled:false,expectedUpdatedAt:'revision-1'});
 await api.gatewayMessages('connection/1','cursor&2');await api.testGatewayConnection('connection/1');await api.deleteGatewayConnection('connection/1');
 assert.deepEqual(JSON.parse(String(calls[0].init?.body)),{name:'Codex',projectId:'project-1',routing:{mode:'pilot'}});
 assert.equal(calls[1].url,'/api/settings/gateway/connections/connection%2F1');assert.equal(calls[1].init?.method,'PATCH');
 assert.deepEqual(JSON.parse(String(calls[1].init?.body)),{enabled:false,expectedUpdatedAt:'revision-1'});
 assert.equal(calls[2].url,'/api/settings/gateway/connections/connection%2F1/messages?limit=20&cursor=cursor%262');
 assert.equal(calls[3].url,'/api/settings/gateway/connections/connection%2F1/test');assert.equal(calls[4].init?.method,'DELETE');
 assert.ok(calls.every(call=>call.init?.credentials==='same-origin'));
});


test('specialist discussion responses remain conversation replies without inventing business tasks',()=>{
 const message:GatewayMessage={...source(),tasks:[],state:'running',conversations:[{id:'discussion-1',projectId:'project-1',sessionId:'pilot',sourceMessageId:'message-1',title:'介绍各自职责',state:'running',createdAt:'2026-11-15T02:42:00Z',deadlineAt:'2026-11-15T02:44:00Z',members:[{id:'member-1',roleId:'r1',roleName:'数据库专员',sessionId:'s1',channelSessionId:'c1',state:'replied'},{id:'member-2',roleId:'r2',roleName:'发布专员',sessionId:'s2',channelSessionId:'c2',state:'running'}]}],replies:[{from:'specialist',conversationId:'discussion-1',roleName:'数据库专员',text:'我负责数据库排查。',createdAt:'2026-11-15T02:42:03Z'}]};
 const html=renderToStaticMarkup(createElement(GatewayMessageTree,{message,connectionName:'我的 Codex'}));
 assert.match(html,/对话回应/);assert.match(html,/数据库专员/);assert.match(html,/我负责数据库排查。/);assert.match(html,/正在回应/);
 assert.doesNotMatch(html,/查看任务|已关联|份报告/);
});


test('an inline Pilot task counts its bound completion report but not its earlier acknowledgement',()=>{
 const message:GatewayMessage={...source(),state:'replied',tasks:[task('pilot-work','completed')],replies:[{from:'pilot',text:'开始检查',createdAt:'2026-11-15T02:42:00Z'},{from:'pilot',taskId:'pilot-work',text:'检查报告',createdAt:'2026-11-15T02:43:00Z'}]};
 assert.equal(gatewayDeliveryText(message),'已收到 1 / 1 份报告 · 回复可在原会话读取');
});


test('Pilot transcript identifies the incoming connection and external conversation while preserving legacy labels',()=>{
 const message:Message={...base,external:{kind:'mcp',connectionId:'c1',connectionName:'我的 Codex',threadId:'t1',threadTitle:'发布前检查'}};
 const html=renderToStaticMarkup(createElement(TranscriptMessage,{sessionId:'channel',message}));
 assert.match(html,/接入渠道：我的 Codex · 会话：发布前检查（MCP）/);assert.match(html,/>我的 Codex<\/small>/);
});
