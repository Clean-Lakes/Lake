import assert from 'node:assert/strict';
import test from 'node:test';
import {orderedTranscript,transcriptGroups} from '../src/timeline';
import {conversationDisplayGroups} from '../src/conversation-progress-model';
import type {SessionSnapshot,AICard} from '../../shared/contracts';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {StrategyCorrectionCard} from '../src/StrategyCorrectionCard';

test('a data-only correction report remains visible with its real turn and outside tool execution groups',()=>{
 const snapshot={messages:[{id:'user',role:'user',createdAt:'2026-10-21T09:00:00Z'}],actions:[],ai:{startedAt:'2026-10-21T09:00:00Z'}} as SessionSnapshot;
 const card:AICard={id:'correction',type:'strategy_correction',status:'completed',at:'2026-10-21T09:00:01Z',data:{stopReason:'awaiting_reconciliation',observations:[{callId:'original',success:false}],requests:2,tokensCharged:600}};
 const entries=orderedTranscript(snapshot,[card],0);
 assert.equal(entries.at(-1)?.id,'correction');assert.deepEqual(entries.at(-1)?.card?.data,card.data);assert.equal(entries.at(-1)?.card?.content,undefined);
 assert.deepEqual(transcriptGroups(entries).map(g=>g.map(e=>e.id)),[['user'],['correction']]);
 const visible=conversationDisplayGroups(entries,false,[]);assert.equal(visible.at(-1)?.entries[0]?.id,'correction');assert.equal(visible.at(-1)?.progress,false);
});

test('correction card exposes real stops and conservative usage without trusting model prose as recovery',()=>{
 const data={schemaVersion:1,id:'run',turnId:'actual-turn',arm:'assets_with_correction',modelRef:'hash',globalEpoch:3,projectEpoch:4,budget:{maxRevisions:2,maxOptimizationRequests:12,maxAdditionalTokens:100000},stopReason:'awaiting_reconciliation',recovered:false,noProgress:1,requests:2,tokensCharged:600,usageUnknown:true,selectedAssets:[],observations:[{callId:'unknown-call',tool:'shell',class:'unknown',success:false,trustedReadOnly:false,evidenceHash:'hash',checkHash:'check'}],revisions:[{sourceId:'unknown-call',refutedHypothesis:'<script>claim success</script>',changes:'read',expectedInformation:'actual result',stopCondition:'stop',tool:'read',arguments:'{}',progress:false}]};
 const html=renderToStaticMarkup(createElement(StrategyCorrectionCard,{card:{id:'report',type:'strategy_correction',status:'completed',at:'',data}}));
 assert.match(html,/操作结果待核实/);assert.match(html,/含保守预留/);assert.match(html,/unknown-call/);assert.match(html,/未证明只读/);assert.match(html,/尚未确认进展/);assert.match(html,/不代表整个任务已恢复/);assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);
});
