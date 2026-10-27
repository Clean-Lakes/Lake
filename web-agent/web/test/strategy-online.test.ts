import assert from 'node:assert/strict';
import test from 'node:test';
import {strategyApi,strategySettingsForm,type StrategySettings,type StrategySettingsView} from '../src/strategyApi';
import {orderedTranscript,transcriptGroups} from '../src/timeline';
import {conversationDisplayGroups} from '../src/conversation-progress-model';
import type {SessionSnapshot,AICard} from '../../shared/contracts';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {StrategySwitches} from '../src/StrategySwitches';
import {StrategyLearning} from '../src/StrategyLearning';
import {StrategyExperiments} from '../src/StrategyExperiments';
import {StrategyCorrectionCard} from '../src/StrategyCorrectionCard';

test('settings saves cannot re-enable retired execution, even with old consent',async()=>{
 const oldFetch=globalThis.fetch;const requests:Record<string,unknown>[]=[];
 globalThis.fetch=async(_url,options)=>{requests.push(JSON.parse(String(options?.body)));return new Response('{}',{status:200})};
 try{
  const old={revision:1,masterEnabled:true,applyEnabled:true,learnEnabled:true,correctEnabled:true,budget:{maxRevisions:2}} as StrategySettings;
  await strategyApi.saveSettings('/api/strategy',old);
  await strategyApi.saveSettings('/api/projects/current/strategy',{...old,onlineCorrectEnabled:true});
  await strategyApi.saveSettings('/api/projects/current/strategy',{...old,onlineCorrectEnabled:true,onlineConsentVersion:2});
  assert.equal(requests[0].onlineCorrectEnabled,false);assert.equal(requests[1].onlineCorrectEnabled,false);assert.equal(requests[1].onlineConsentVersion,0);assert.equal(requests[2].onlineCorrectEnabled,false);assert.equal(requests[2].onlineConsentVersion,0);for(const request of requests){assert.equal(request.learnEnabled,false);assert.equal(request.correctEnabled,false);}assert.equal(requests[1].expectedRevision,1);
 }finally{globalThis.fetch=oldFetch}
});

test('an unsaved project inherits manual application while discarding retired consent and retaining CAS',()=>{
 const project={scope:{kind:'project',projectId:'current'},revision:0,epoch:0,masterEnabled:false,applyEnabled:false,learnEnabled:false,correctEnabled:false,onlineCorrectEnabled:false,budget:{maxRevisions:2}} as StrategySettings;
 const view={settings:project,effective:{...project,masterEnabled:true,applyEnabled:true,correctEnabled:true,onlineCorrectEnabled:true,onlineConsentVersion:2},source:'inherited',capabilities:{apply:true,learn:true,correct:true}} satisfies StrategySettingsView;
 const form=strategySettingsForm(view);assert.equal(form.settings.onlineCorrectEnabled,false);assert.equal(form.settings.onlineConsentVersion,0);assert.equal(form.settings.masterEnabled,true);assert.equal(form.settings.applyEnabled,true);assert.equal(form.settings.revision,0);assert.equal(form.settings.epoch,0);assert.deepEqual(form.settings.scope,project.scope);assert.equal(view.settings.onlineCorrectEnabled,false);
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


test('manual controls have no learning or online execution inputs while preserving adopted content',()=>{
 const settings={scope:{kind:'user'},revision:2,epoch:2,masterEnabled:true,applyEnabled:true,learnEnabled:true,correctEnabled:true,onlineCorrectEnabled:true,budget:{}} as StrategySettings;
 const view={settings,effective:settings,source:'saved',capabilities:{apply:true,learn:false,correct:false}};
 const html=renderToStaticMarkup(createElement(StrategySwitches,{view,disabled:false,onChange:()=>{},onSave:()=>{}}));
 assert.match(html,/会话应用已采用资产/);assert.match(html,/候选提取和新增对照实验已停用/);
 assert.equal((html.match(/type="checkbox"/g)||[]).length,2);
 assert.ok(!html.includes('积累待审核候选'));assert.ok(!html.includes('我同意本版本'));assert.ok(!html.includes('<details'));
});

test('history panels retain reading and withdrawal without new generation or experiment controls',()=>{
 const run=async(task:()=>Promise<void>)=>task();
 const learning=renderToStaticMarkup(createElement(StrategyLearning,{base:'/api/projects/current/strategy',busy:false,run,onAssetsChange:async()=>{}}));
 const experiments=renderToStaticMarkup(createElement(StrategyExperiments,{base:'/api/projects/current/strategy',busy:false,run}));
 assert.match(learning,/历史候选与来源/);assert.match(learning,/未知调用不会自动重发/);
 assert.ok(!learning.includes('登记为纠正来源'));assert.ok(!learning.includes('从选中来源生成候选'));assert.ok(!learning.includes('<input'));
 assert.match(experiments,/历史对照实验/);assert.match(experiments,/不继续旧任务/);
 assert.ok(!experiments.includes('开始 A/B'));assert.ok(!experiments.includes('选择场景'));assert.ok(!experiments.includes('<select'));
});
