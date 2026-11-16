import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AICard,AIView,ReplyTiming,SessionSnapshot,SpecialistChannelInfo,SuperWorker,SuperWorkspace} from '../../shared/contracts';
import {ReplyDuration,type ReplyDurationProps} from '../src/ReplyDuration';
import {SpecialistAvatarProvider} from '../src/SuperRoleAvatar';
import {AITranscript} from '../src/AIPanel';
import {PilotSpecialistReplyView} from '../src/PilotSpecialistConversation';
import {ReplyIdentity} from '../src/ReplyIdentity';
import {pilotDispatchRows} from '../src/pilotSpecialistReplies';
import {PilotConversationProgress} from '../src/PilotConversationProgress';
import {allowsAnimalThinking,turnStatus} from '../src/turnStatus';

const at='2026-11-15T00:00:00Z';
const now=Date.parse(at)+4000;
const timing:ReplyTiming={messageId:'user',startedAt:at,finishedAt:'',status:'running'};
const identity={name:'同名专员',roleId:'role-a',avatarId:'otter' as const};
const view=(extra:Partial<AIView>={}):AIView=>({session:'worker',status:'running',turnStartedAt:at,cards:[],cardsOffset:0,profile:'',turns:1,totalCards:0,usage:{},...extra});
const render=(props:ReplyDurationProps={})=>renderToStaticMarkup(createElement(ReplyDuration,{assistantIdentity:identity,timing,view:view(),...props}));
const channel=(roleId:string,avatarId:SpecialistChannelInfo['avatarId']):SpecialistChannelInfo=>({id:roleId,roleId,roleName:'同名专员',avatarId,sessionId:roleId,projectId:'project',revision:1,createdAt:at});

test('current specialist thinking uses the same exact avatar for copy and the 28px border character',t=>{
 t.mock.method(Date,'now',()=>now);
 const channels=[channel('role-a','turtle'),channel('role-b','owl')];
 const withProvider=(roleId:string,avatarId?:'otter')=>renderToStaticMarkup(createElement(SpecialistAvatarProvider,{channels,children:createElement(ReplyDuration,{timing,view:view(),assistantIdentity:{name:'同名专员',roleId,avatarId}})}));
 const turtle=withProvider('role-a'),owl=withProvider('role-b'),explicit=withProvider('role-a','otter');
 assert.match(turtle,/data-animal="turtle"/);assert.match(turtle,/正在慢慢推演中/);
 assert.match(owl,/data-animal="owl"/);assert.match(owl,/正在歪头推敲中/);
 assert.match(explicit,/data-animal="otter"/);assert.match(explicit,/正在搓爪琢磨中/);
 assert.match(explicit,/width="28" height="28"/);
 assert.equal((explicit.match(/role="status"/g)??[]).length,1);
 assert.doesNotMatch(explicit,/turn-activity-mark|status-text--active|turn-thinking-avatar|response-avatar/);
});

test('animal thinking appears before the first packet and yields directly to visible prose',t=>{
 t.mock.method(Date,'now',()=>Date.parse(at)+100);
 const snapshot:SessionSnapshot={session:{id:'worker',workspaceRole:'worker'},messages:[{id:'user',sessionId:'worker',role:'user',text:'继续',createdAt:at}],resources:[],actions:[],replyTimings:[timing],ai:view({status:'idle'})} as SessionSnapshot;
 const transcript=()=>renderToStaticMarkup(createElement(AITranscript,{snapshot,assistantIdentity:identity}));
 assert.match(transcript(),/正在搓爪琢磨中/);
 snapshot.ai!.status='running';snapshot.ai!.cards=[{id:'empty',type:'message',status:'running',content:' ',at}];
 assert.match(transcript(),/animal-thinking-bubble/);
 snapshot.ai!.cards[0]!.content='这是实际回复。';
 const prose=transcript();assert.match(prose,/这是实际回复。/);assert.doesNotMatch(prose,/animal-thinking-bubble|正在搓爪琢磨中|turn-activity-mark/);
});

test('animal bubble keeps elapsed time, disclosure and genuine warnings outside its stable copy',t=>{
 t.mock.method(Date,'now',()=>now);
 const html=render({detailNotice:'1 项结果待核查',disclosure:{open:false,controls:'execution-details',side:true,onToggle(){}}});
 assert.match(html,/animal-thinking-meta/);assert.match(html,/已处理 4秒/);
 assert.match(html,/aria-label="查看执行详细过程" aria-expanded="false" aria-controls="execution-details"/);
 assert.match(html,/1 项结果待核查/);
 assert.ok(html.indexOf('正在搓爪琢磨中')<html.indexOf('已处理 4秒'));
 assert.doesNotMatch(html,/turn-current-step|status-text--active|turn-activity-mark/);
});

test('tools, compression, waits, offline, history and elapsed previews never become animal thinking',t=>{
 t.mock.method(Date,'now',()=>now);
 const tool:AICard={id:'tool',type:'operation',title:'inspect_host',status:'running',at};
 const compact:AICard={id:'compact',type:'compaction',status:'running',at};
 const cases:ReplyDurationProps[]=[
  {cards:[tool],view:view({cards:[tool]})},{view:view({cards:[compact]}),cards:[compact]},
  {view:view({status:'waiting_approval'})},{view:view({question:{id:'q',questions:[]}})},
  {connected:false},{current:false},{previewAt:now},{elapsedOnly:true},{processOnly:true},
  ...(['completed','failed','cancelled','interrupted'] as const).map(status=>({timing:{...timing,status,finishedAt:new Date(now).toISOString()}})),
  ...['failed','cancelled','paused','blocked','completed'].map(status=>({view:view({status})})),
 ];
 for(const props of cases)assert.doesNotMatch(render(props),/animal-thinking-bubble/,JSON.stringify(props));
 assert.match(render({view:view({cards:[compact]})}),/正在压缩上下文/);
 assert.match(render({cards:[tool]}),/正在执行工具/);
 assert.match(render({connected:false}),/等待重新连接/);assert.doesNotMatch(render({connected:false}),/turn-activity-mark|status-text--active/);
 assert.match(render({timing:{...timing,status:'failed',finishedAt:new Date(now).toISOString()}}),/未完成/);
 assert.match(render({timing:{...timing,status:'cancelled',finishedAt:new Date(now).toISOString()}}),/已停止/);
});

test('typed queued and waiting states remain accurate and static even with an old running clock',t=>{
 t.mock.method(Date,'now',()=>now);
 const cases:[Partial<AIView>,string][]=[
  [{status:'queued'},'排队等待'],[{status:'waiting_input'},'等待你补充信息'],[{status:'waiting_external'},'等待外部结果'],
  [{status:'waiting_approval',replyStatus:'running'},'等待确认'],[{status:'waiting_input',replyStatus:'running'},'等待你补充信息'],[{status:'waiting_external',replyStatus:'running'},'等待外部结果'],[{status:'queued',replyStatus:'running'},'排队等待'],
  [{pending:{} as NonNullable<AIView['pending']>},'等待确认'],[{pendingApprovals:[{} as NonNullable<AIView['pending']>]},'等待确认'],
 ];
 for(const [extra,label]of cases){
  const current=view(extra),html=render({view:current});
  assert.equal(allowsAnimalThinking(current),false);assert.equal(turnStatus(timing,current,[],at,now).phase,'waiting');
  assert.ok(html.includes(label),label);assert.doesNotMatch(html,/animal-thinking-bubble|turn-activity-mark|status-text--active/);
 }
 for(const [status,label]of [['cancelled','已停止'],['failed','未完成'],['paused','已暂停'],['interrupted','记录已中断']]){const html=render({view:view({status,replyStatus:'running'})});assert.ok(html.includes(label));assert.doesNotMatch(html,/animal-thinking-bubble|turn-activity-mark|status-text--active/);}
 assert.equal(allowsAnimalThinking(view({status:'blocked',replyStatus:'running'})),true,'an actual reply still owns activity over an old blocked goal');
});

test('Pilot and ordinary Lake without a specialist identity keep their original water feedback',t=>{
 t.mock.method(Date,'now',()=>now);
 for(const assistantIdentity of [undefined,{name:'Pilot',pilot:true}]){
  const html=render({assistantIdentity});assert.match(html,/turn-activity-mark/);assert.match(html,/正在思考/);assert.doesNotMatch(html,/animal-thinking-bubble/);
 }
});

test('a terminal view wins over a stale running timer and reconnect caption immediately',t=>{
 t.mock.method(Date,'now',()=>Date.parse(at)+100);
 const latestStep:AICard={id:'tool',type:'operation',title:'inspect_host',status:'running',at};
 for(const connected of [true,false])for(const [status,label]of [['failed','未完成'],['cancelled','已停止'],['interrupted','记录已中断']]){
  const html=render({connected,view:view({status,replyStatus:'running'}),latestStep,disclosure:{open:false,controls:'steps',onToggle(){}}});
  assert.ok(html.includes(label),label);assert.doesNotMatch(html,/等待重新连接|animal-thinking-bubble|turn-activity-mark|status-text--active/);
 }
});

function specialistRow(){
 const worker:SuperWorker={id:'worker-a',roleId:'role-a',roleName:'同名专员',sessionId:'worker',assignmentState:'active',task:{taskId:'task-a',sessionId:'worker',projectId:'project',title:'核对当前状态',state:'running',acceptanceState:'not_evaluated',revision:1},activity:{phase:'thinking',label:'正在分析',updatedAt:at,sourceSessionId:'pilot',sourceMessageId:'user'}};
 const workspace:SuperWorkspace={active:true,project:{projectId:'project',routerSessionId:'pilot',version:1},workers:[worker],channels:[channel('role-a','owl')]};
 const row=pilotDispatchRows(workspace,'pilot',[{id:'user',sessionId:'pilot',role:'user',text:'检查',createdAt:at}])[0]!;
 row.author.avatarId='owl';return row;
}

test('Pilot shows animal-specific thinking text under its original identity, then public output replaces only that text',t=>{
 t.mock.method(Date,'now',()=>now);
 const row=specialistRow();
 const snapshot={session:{id:'worker',projectId:'project'},superagent:{roleId:row.worker.roleId,task:row.worker.task},cursor:1,ai:view({rootTurnId:'root'})} as SessionSnapshot;
 const html=(available=true)=>renderToStaticMarkup(createElement(PilotSpecialistReplyView,{row,snapshot,available}));
 const thinking=html();
 assert.match(thinking.replace(/<[^>]*>/g,''),/正在歪头推敲中/);
 assert.match(thinking,/data-live-motion="active"/);
 assert.equal((thinking.match(/data-live-glow="active"/g)??[]).length,2,'only the original name and thinking text opt in to the soft glow');
 assert.equal((thinking.match(/role="status"/g)??[]).length,1);
 assert.doesNotMatch(thinking,/animal-thinking-bubble|animal-thinking-character|turn-activity-mark|status-text--active/);
 assert.match(renderToStaticMarkup(createElement(PilotSpecialistReplyView,{row})).replace(/<[^>]*>/g,''),/正在歪头推敲中/,'the exact dispatched worker has feedback before the first model packet');
 for(const phase of ['queued','tool','waiting_approval','waiting_input','waiting_external'] as const){row.activity.phase=phase;assert.match(html(),/reply-process-status/,phase);assert.doesNotMatch(html(),/animal-thinking-bubble|pilot-specialist-thinking-label/,phase);}
 row.activity.phase='thinking';assert.doesNotMatch(html(false),/animal-thinking-bubble|pilot-specialist-thinking-label|data-live-glow="active"/);assert.match(html(false),/正在重连/);
 snapshot.ai!.cards=[{id:'compact',type:'compaction',status:'running',at}];
 assert.doesNotMatch(html(),/animal-thinking-bubble|pilot-specialist-thinking-label/);assert.match(html(),/正在压缩上下文/);
 snapshot.ai!.cards=[{id:'reply',type:'message',status:'running',content:'这是本次检查结果。',at,data:{root_turn_id:'root'}}];
 assert.match(html().replace(/<[^>]*>/g,''),/这是本次检查结果。/);assert.doesNotMatch(html(),/animal-thinking-bubble|pilot-specialist-thinking-label|turn-activity-mark|正在生成回复/);
 assert.match(html(),/data-live-motion="active"/);
 assert.equal((html().match(/data-live-glow="active"/g)??[]).length,1,'the public body stays quiet while the existing name keeps its glow');
 assert.equal(html().match(/<div class="response-identity">[\s\S]*?<\/div>/)?.[0],thinking.match(/<div class="response-identity">[\s\S]*?<\/div>/)?.[0],'the identity stays in the same parent and retains the same author while its content slot changes');
});

test('Pilot thinking copy follows the exact original avatar for explicit IDs, project roles and duplicate names',()=>{
 const channels=[channel('role-a','turtle'),channel('role-b','owl')];
 const renderThinking=(roleId:string,avatarId?:'otter',visible=true)=>{
  const row=specialistRow();row.author={...row.author,roleId,avatarId};
  return renderToStaticMarkup(createElement(SpecialistAvatarProvider,{channels,children:createElement(PilotSpecialistReplyView,{row,visible,onSpecialist(){}})}));
 };
 for(const [roleId,avatarId,animal,label] of [['role-a',undefined,'turtle','正在慢慢推演中'],['role-b',undefined,'owl','正在歪头推敲中'],['role-a','otter','otter','正在搓爪琢磨中']] as const){
  const html=renderThinking(roleId,avatarId);
  assert.ok(html.replace(/<[^>]*>/g,'').includes(label));assert.ok(html.includes(`data-avatar="${animal}"`));
  assert.equal((html.match(/class="response-avatar"/g)??[]).length,1);
  assert.equal((html.match(/role="status"/g)??[]).length,1);
  assert.match(html,/<button type="button" class="response-author"/);
  assert.doesNotMatch(html,/animal-thinking-bubble|animal-thinking-character|turn-activity-mark|status-text--active/);
 }
 const hidden=renderThinking('role-a','otter',false);
 assert.match(hidden,/data-live-motion="still"/);assert.doesNotMatch(hidden,/data-live-(?:motion|glow)="active"/);assert.match(hidden.replace(/<[^>]*>/g,''),/正在搓爪琢磨中/,'hidden pages pause both effects without deleting the real state');
});

test('Pilot public prose keeps its original specialist entry and execution logo outside any bubble',()=>{
 for(const backend of [{kind:'native'},{kind:'acp',agent:'codex'}] as const){
  const row=specialistRow();
  row.author.name='负责基础设施与数据库检查的长期专员'.repeat(3);
  row.author.execution=backend;
  const onSpecialist=()=>{};
  const snapshot={session:{id:'worker',projectId:'project'},superagent:{roleId:row.worker.roleId,task:row.worker.task},cursor:1,ai:view({rootTurnId:'root',cards:[{id:'reply',type:'message',status:'running',content:'这是专员真正公开的回复。',at,data:{root_turn_id:'root'}}]})} as SessionSnapshot;
  const html=renderToStaticMarkup(createElement(PilotSpecialistReplyView,{row,snapshot,onSpecialist}));
  assert.match(html,/<section[^>]*><div class="response-identity">/,'the entry stays in its original parent for prose, tools and waits');
  assert.equal((html.match(/class="response-identity/g)??[]).length,1);
  assert.equal((html.match(/data-avatar="owl"/g)??[]).length,1);
  assert.equal((html.match(/class="response-avatar"/g)??[]).length,1);
  assert.doesNotMatch(html,/animal-thinking-bubble|animal-thinking-surface|turn-activity-mark/);
  assert.match(html,/<button type="button" class="response-author"/);
  assert.equal(html.match(/<strong>([\s\S]*?)<\/strong>/)?.[1].replace(/<[^>]*>/g,''),row.author.name,'the full long name remains available to layout and accessible naming');
  assert.ok(html.includes(`aria-label="与${row.author.name}继续沟通 · Agent 类型：${backend.kind==='native'?'Lake':'Codex'}"`));
  assert.equal((html.match(/data-agent-type=/g)??[]).length,1);
  assert.ok(html.includes(`data-agent-type="${backend.kind==='native'?'native':'codex'}"`),'branding follows the real execution binding');
  assert.ok(html.indexOf('<button')<html.indexOf('class="ai-card ai-message"'));
  assert.match(html.replace(/<[^>]*>/g,''),/这是专员真正公开的回复。/);
  assert.match(html,/data-live-motion="active"/);
  assert.equal((html.match(/role="status"/g)??[]).length,0,'public prose does not add a synthetic thinking announcement');
 }
});

test('the original identity retains its native button and exact specialist navigation target',()=>{
 const row=specialistRow();let selected:typeof row.author|undefined;
 const identity=ReplyIdentity({identity:{name:'Pilot',pilot:true},author:row.author,onSpecialist:author=>{selected=author;}})!;
 const button=identity.props.children;
 assert.equal(button.type,'button');assert.equal(button.props.type,'button');
 assert.equal(button.props.disabled,undefined);assert.equal(button.props.tabIndex,undefined,'native keyboard activation stays enabled');
 button.props.onClick();
 assert.equal(selected,row.author,'navigation retains the original worker, task and channel identity');
});

test('tool, wait, reconnect, settled and actual prose all retain the original separate identity',()=>{
 const row=specialistRow();
 const snapshot={session:{id:'worker',projectId:'project'},superagent:{roleId:row.worker.roleId,task:row.worker.task},cursor:1,ai:view({rootTurnId:'root'})} as SessionSnapshot;
 const renderReply=(available=true)=>renderToStaticMarkup(createElement(PilotSpecialistReplyView,{row,snapshot,available,onSpecialist(){}}));
 const assertSeparate=(html:string)=>{
  assert.match(html,/^<section[^>]*><div class="response-identity">/);
  assert.equal((html.match(/class="response-avatar"/g)??[]).length,1);
  assert.doesNotMatch(html,/animal-thinking-bubble|has-identity/);
 };
 for(const phase of ['tool','queued','waiting_approval','waiting_input','waiting_external'] as const){row.activity.phase=phase;assertSeparate(renderReply());}
 row.activity.phase='thinking';assertSeparate(renderReply(false));
 snapshot.ai!.status='completed';assertSeparate(renderReply());
 snapshot.ai!.status='running';snapshot.ai!.cards=[{id:'reply',type:'message',status:'running',content:'实际正文接替思考气泡。',at,data:{root_turn_id:'root'}}];
 const prose=renderReply();assertSeparate(prose);assert.match(prose.replace(/<[^>]*>/g,''),/实际正文接替思考气泡/);
});

test('Pilot identity moves only during connected visible execution while public text stays intact through waits and termination',()=>{
 const row=specialistRow();
 const content='已收到的真实公开正文不因暂停、失败或断线丢失。';
 const snapshot={session:{id:'worker',projectId:'project'},superagent:{roleId:row.worker.roleId,task:row.worker.task},cursor:1,ai:view({rootTurnId:'root',replyStatus:'running',cards:[{id:'reply',type:'message',status:'running',content,at,data:{root_turn_id:'root'}}]})} as SessionSnapshot;
 const renderReply=(extra:{available?:boolean;visible?:boolean}={})=>renderToStaticMarkup(createElement(PilotSpecialistReplyView,{row,snapshot,...extra}));
 for(const phase of ['thinking','tool'] as const){row.activity.phase=phase;assert.match(renderReply(),/data-live-motion="active"/);}
 const assertStill=(html:string)=>{assert.ok(html.replace(/<[^>]*>/g,'').includes(content));assert.match(html,/data-live-motion="still"/);assert.doesNotMatch(html,/animal-thinking-bubble|turn-activity-mark|status-text--active|data-live-(?:motion|glow)="active"/);};
 assertStill(renderReply({available:false}));assert.match(renderReply({available:false}),/进度暂未更新，正在重连/);
 assertStill(renderReply({visible:false}));
 for(const phase of ['waiting_approval','waiting_input','waiting_external'] as const){row.activity.phase=phase;assertStill(renderReply());}
 row.activity.phase='thinking';
 for(const status of ['queued','waiting_approval','waiting_input','waiting_external','paused','cancelled','failed','interrupted']){snapshot.ai!.status=status;assertStill(renderReply());}
 snapshot.ai!.status='completed';snapshot.ai!.replyStatus='completed';assertStill(renderReply());
 snapshot.ai!.status='running';snapshot.ai!.replyStatus='running';snapshot.ai!.pendingApprovals=[{} as NonNullable<AIView['pending']>];assertStill(renderReply());
});

test('discussion member running is not enough evidence to invent animal thinking',()=>{
 const html=renderToStaticMarkup(createElement(PilotConversationProgress,{rounds:[{id:'round',projectId:'project',sessionId:'pilot',sourceMessageId:'user',state:'running',members:[{id:'member',roleId:'role-a',roleName:'同名专员',sessionId:'worker',state:'running',avatarId:'otter'}]}] as never}));
 assert.match(html,/正在回复/);assert.doesNotMatch(html,/animal-thinking-bubble/);
});

test('Pilot live snapshots stop every work loop for pending cards, child waits and explicit terminal states',t=>{
 t.mock.method(Date,'now',()=>now);
 const row=specialistRow();
 const base={session:{id:'worker',projectId:'project'},superagent:{roleId:row.worker.roleId,task:row.worker.task},cursor:1} as SessionSnapshot;
 const cases:[Partial<AIView>,string][]=[
  [{cards:[{id:'approval',type:'operation',status:'pending',at}]},'等待确认'],
  [{agentRuns:[{id:'child',sessionId:'worker',rootTurnId:'root',createdAt:at,status:'waiting_input'}] as AIView['agentRuns']},'等待确认'],
  [{status:'waiting_input'},'等待你补充信息'],[{status:'waiting_external'},'等待外部结果'],
  [{status:'waiting_approval'},'等待确认'],[{status:'queued'},'排队等待'],
  [{status:'cancelled'},'已停止'],[{status:'failed'},'未完成'],[{status:'interrupted'},'记录已中断'],
 ];
 for(const phase of ['thinking','tool'] as const)for(const [extra,label]of cases){
  row.activity.phase=phase;
  const snapshot={...base,ai:view({rootTurnId:'root',replyStatus:'running',...extra})};
  const html=renderToStaticMarkup(createElement(PilotSpecialistReplyView,{row,snapshot}));
  assert.ok(html.includes(label),`${phase}: ${label}`);
  assert.doesNotMatch(html,/animal-thinking-bubble|pilot-specialist-thinking-label|turn-activity-mark|status-text--active|data-motion="working"|data-live-(?:motion|glow)="active"/);
 }
});
