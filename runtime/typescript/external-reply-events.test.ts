import test from 'node:test';
import assert from 'node:assert/strict';
import {externalReplyTextUpdate,recordExternalReplyStage} from './external-reply-events';
import type {AICard} from '../../web-agent/shared/contracts';
import type {ExternalEvent,ExternalRun} from './acp/types';
import {externalReplyStages} from '../../web-agent/shared/external-agents';

test('only public root ACP Worker text gets a prefix; child and tool records remain separate',()=>{
 const card:AICard={id:'run',type:'operation',status:'running',at:'2026-11-12T00:00:00Z',content:'当前公开回复',data:{source:'external_agent',external_run_id:'run'}};
 const before=JSON.stringify(card);
 const expected={target:'card',id:'run',content:'当前公开回复',cardType:'operation',at:card.at,rootTurnId:'root'};
 assert.deepEqual(externalReplyTextUpdate({purpose:'worker'},{kind:'text'},card,'root').textUpdate,expected);
 for(const run of [{purpose:'segment' as const},{purpose:'child' as const},{purpose:'worker' as const,childSessionId:'child'},{purpose:'worker' as const,agentRunId:'child-run'}])
  assert.deepEqual(externalReplyTextUpdate(run,{kind:'text'},card,'root'),{});
 assert.deepEqual(externalReplyTextUpdate({purpose:'worker'},{kind:'tool'},card,'root'),{});
 assert.deepEqual(externalReplyTextUpdate({purpose:'worker'},{kind:'text'},card),{});
 assert.equal(JSON.stringify(card),before,'the audit card does not become a stored chat message');
});

test('public ACP message prefixes accompany the unchanged cumulative audit prefix',()=>{
 const card:AICard={id:'run',type:'operation',status:'running',at:'2026-11-12T00:00:00Z',content:'过程句。最终结论。',data:{source:'external_agent',external_run_id:'run',external_reply:{id:'last-message',content:'最终结论。'}}};
 const before=JSON.stringify(card),update=externalReplyTextUpdate({purpose:'worker'},{kind:'text'},card,'root').textUpdate!;
 assert.equal(update.content,'过程句。最终结论。');
 assert.deepEqual(update.externalReply,{id:'last-message',content:'最终结论。'});
 assert.deepEqual(externalReplyTextUpdate({purpose:'worker'},{kind:'status'},card,'root'),{});
 assert.equal(JSON.stringify(card),before,'a late status never clears or rewrites the retained message projection');
 for(const invalid of [{content:'missing id'},{id:'message',content:3},{id:'',content:'empty id'}]){
  const update=externalReplyTextUpdate({purpose:'worker'},{kind:'text'},{...card,data:{external_reply:invalid}},'root').textUpdate!;
  assert.equal(update.externalReply,undefined);
 }
});

test('each real public message and tool group has a stable phase, including late tool completions',()=>{
 const at='2026-11-12T00:00:00Z',run={id:'run',taskId:'task',rootTurnId:'root',purpose:'worker'} as ExternalRun;
 const card:AICard={id:run.id,type:'operation',status:'running',at,content:'retained audit',
  data:{source:'external_agent',external_run_id:run.id,taskId:run.taskId,root_turn_id:run.rootTurnId}};
 const emit=(event:Omit<ExternalEvent,'at'|'sequence'>)=>recordExternalReplyStage(run,{...event,at,sequence:1},card);
 const prose=(id:string,content:string)=>{
  card.data={...card.data as object,external_reply:{id,content}};
  return emit({kind:'text',publicTextId:id,publicText:'PRIVATE_RAW_PREFIX'});
 };
 const tool=(callId:string,status:string)=>emit({kind:status==='running'?'tool':'tool_update',callId,status,title:'PRIVATE_TOOL_TITLE'});
 prose('a','先核对。');
 const first=tool('call-1','running')!.stage;
 assert.equal(tool('call-2','running')!.stage.id,first.id);
 assert.equal(tool('call-1','running'),undefined);
 prose('b','开始汇总');
 const second=tool('call-3','running')!.stage;
 assert.notEqual(second.id,first.id);
 assert.equal(tool('call-1','completed')!.stage.id,first.id);
 assert.equal(tool('call-2','failed')!.stage.id,first.id);
 assert.equal(tool('call-2','completed'),undefined);
 prose('b','开始汇总。');
 prose('c','继续验证。');
 const after=externalReplyStages((card.data as Record<string,unknown>).external_reply_stages);
 assert.deepEqual(after,[{kind:'prose',id:'a',content:'先核对。'},
  {kind:'tools',id:first.id,progress:{total:2,running:0,failed:1}},
  {kind:'prose',id:'b',content:'开始汇总。'},
  {kind:'tools',id:second.id,progress:{total:1,running:1,failed:0}},
  {kind:'prose',id:'c',content:'继续验证。'}]);
 assert.doesNotMatch(JSON.stringify(after),/PRIVATE_|call-[123]/);
 assert.equal(card.content,'retained audit');
 assert.equal(recordExternalReplyStage({...run,childSessionId:'child'},{kind:'tool',callId:'child',status:'running',at,sequence:2},card),undefined);
});

test('consecutive different Codex actions open distinct rows and a fast completion still creates a named row',()=>{
 const at='2026-11-12T00:00:00Z',run={id:'run',taskId:'task',rootTurnId:'root',purpose:'worker'} as ExternalRun;
 const card:AICard={id:run.id,type:'operation',status:'running',at,
  data:{source:'external_agent',external_run_id:run.id,taskId:run.taskId,root_turn_id:run.rootTurnId}};
 const emit=(kind:'tool'|'tool_update',callId:string,tool:string,status:string,integration?:string)=>recordExternalReplyStage(run,{
  kind,callId,at,sequence:1,status,title:'RAW_PRIVATE_DATA',action:{tool,integration},
 },card)?.stage;
 const lookup=emit('tool','a','list_assets','running')!;
 assert.equal(emit('tool_update','a','list_assets','completed')?.id,lookup.id);
 const firstCommand=emit('tool','b','Bash','running')!;
 assert.notEqual(firstCommand.id,lookup.id);
 assert.equal(emit('tool','c','Bash','running')?.id,firstCommand.id);
 const search=emit('tool_update','d','search_web','completed','样例知识库')!;
 assert.notEqual(search.id,firstCommand.id);
 assert.equal(emit('tool_update','d','search_web','completed','样例知识库'),undefined);
 assert.equal(emit('tool_update','c','Bash','failed')?.id,firstCommand.id);
 const stages=externalReplyStages((card.data as Record<string,unknown>).external_reply_stages);
 assert.deepEqual(stages.map(stage=>stage.kind==='tools'?stage.action?.tool:undefined),['list_assets','Bash','search_web']);
 assert.deepEqual(stages.at(-1),{kind:'tools',id:search.id,action:{tool:'search_web',integration:'样例知识库'},progress:{total:1,running:0,failed:0}});
 assert.doesNotMatch(JSON.stringify(stages),/RAW_PRIVATE_DATA/);
});
