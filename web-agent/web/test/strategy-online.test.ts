import assert from 'node:assert/strict';
import test from 'node:test';
import {strategyApi,strategySettingsForm,type StrategySettings,type StrategySettingsView} from '../src/strategyApi';
import {orderedTranscript,transcriptGroups} from '../src/timeline';
import {conversationDisplayGroups} from '../src/conversation-progress-model';
import type {SessionSnapshot,AICard} from '../../shared/contracts';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {StrategyCorrectionCard} from '../src/StrategyCorrectionCard';

test('online execution needs its own saved consent; old settings do not enable it',async()=>{
 const oldFetch=globalThis.fetch;const requests:Record<string,unknown>[]=[];
 globalThis.fetch=async(_url,options)=>{requests.push(JSON.parse(String(options?.body)));return new Response('{}',{status:200})};
 try{
  const old={revision:1,masterEnabled:true,applyEnabled:true,learnEnabled:true,correctEnabled:true,budget:{maxRevisions:2}} as StrategySettings;
  await strategyApi.saveSettings('/api/strategy',old);
  await strategyApi.saveSettings('/api/projects/current/strategy',{...old,onlineCorrectEnabled:true});
  assert.equal(requests[0].onlineCorrectEnabled,false);assert.equal(requests[1].onlineCorrectEnabled,true);assert.equal(requests[1].expectedRevision,1);
 }finally{globalThis.fetch=oldFetch}
});

test('an unsaved project shows inherited online consent while retaining project CAS and ownership',()=>{
 const project={scope:{kind:'project',projectId:'current'},revision:0,epoch:0,masterEnabled:false,applyEnabled:false,learnEnabled:false,correctEnabled:false,onlineCorrectEnabled:false,budget:{maxRevisions:2}} as StrategySettings;
 const view={settings:project,effective:{...project,masterEnabled:true,correctEnabled:true,onlineCorrectEnabled:true},source:'inherited',capabilities:{apply:true,learn:true,correct:true}} satisfies StrategySettingsView;
 const form=strategySettingsForm(view);assert.equal(form.settings.onlineCorrectEnabled,true);assert.equal(form.settings.revision,0);assert.equal(form.settings.epoch,0);assert.deepEqual(form.settings.scope,project.scope);assert.equal(view.settings.onlineCorrectEnabled,false);
 assert.equal(strategySettingsForm({...view,source:'stored'}).settings.onlineCorrectEnabled,false);
});

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
