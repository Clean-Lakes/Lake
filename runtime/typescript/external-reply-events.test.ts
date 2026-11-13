import test from 'node:test';
import assert from 'node:assert/strict';
import {externalReplyTextUpdate} from './external-reply-events';
import type {AICard} from '../../web-agent/shared/contracts';

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
