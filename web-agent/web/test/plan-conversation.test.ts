import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {SessionSnapshot} from '../../shared/contracts';
import type {TranscriptEntry} from '../src/timeline';
import {AITranscript} from '../src/AIPanel';
import {conversationPlanEntry} from '../src/planConversation';

const at='2026-10-22T01:00:00Z';
const body='# PLAN_BODY_MUST_STAY_IN_LIST\n\n1. HIDDEN_PLAN_STEP\n2. 验证结果。';
const text=`已确认检查范围。\n\n<proposed_plan>\n${body}\n</proposed_plan>\n请审阅。`;
function snapshot(status='completed'):SessionSnapshot {
 return {conversationMode:'plan',session:{id:'plan-case',projectId:'project',title:'计划展示',status:status==='running'?'investigating':status},messages:[{id:'user',role:'user',createdAt:'2026-10-22T00:59:59Z',text:'制定检查计划'}],resources:[],actions:[],terminals:[],evidence:[],ai:{session:'plan-case',status,cards:[{id:'plan',type:'message',content:text,at,status,data:status==='completed'?{proposedPlan:true}:undefined}],cardsOffset:0,totalCards:1,proposedPlan:status==='completed'?{id:'plan',content:body,at}:undefined,usage:{input:10,output:10,total:20},profile:'core',turns:1}} as SessionSnapshot;
}

test('chat renders a plan reference without mounting its body or chat execution actions',()=>{
 const value=snapshot();
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:value,onOpenPlans:()=>{}}));
 assert.match(html,/计划已保存/);assert.match(html,/查看计划列表/);assert.match(html,/制定检查计划/);
 assert.doesNotMatch(html,/PLAN_BODY_MUST_STAY_IN_LIST|HIDDEN_PLAN_STEP|proposed_plan|执行计划|修改计划/);
 assert.equal(value.ai!.cards[0]!.content,text,'canonical history remains intact for plan review');
 assert.equal(value.ai!.proposedPlan!.content,body);
 value.conversationMode='default';
 assert.doesNotMatch(renderToStaticMarkup(createElement(AITranscript,{snapshot:value})),/HIDDEN_PLAN_STEP/,'historical plans stay out of chat after leaving Plan mode');
});

test('every streamed plan prefix stays out of conversation presentation',()=>{
 const start=text.indexOf('<proposed_plan>');
 for(let length=start+1;length<=text.length;length++){
  const entry:TranscriptEntry={id:'plan',at,card:{id:'plan',type:'message',content:text.slice(0,length),status:'running',at}};
  const projected=conversationPlanEntry(entry,{planMode:true,live:true});
  assert.equal(projected.card?.type,'plan_reference');
  assert.doesNotMatch(JSON.stringify(projected),/HIDDEN_PLAN_STEP|proposed_plan/);
 }
 const value=snapshot('running');
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:value,onOpenPlans:()=>{}}));
 assert.match(html,/正在生成计划/);assert.doesNotMatch(html,/HIDDEN_PLAN_STEP|proposed_plan/);
});

test('failed plan drafts hide their body while retaining the failure and ordinary clarification',()=>{
 const value=snapshot('failed');
 value.ai!.cards.push({id:'error',type:'error',content:'检查未完成，请继续。',status:'failed',at:'2026-10-22T01:00:01Z'});
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot:value}));
 assert.match(html,/计划未完成/);assert.match(html,/检查未完成，请继续/);assert.doesNotMatch(html,/HIDDEN_PLAN_STEP/);
 for(const content of ['需要核对全部数据库还是指定库？','协议示例：\n```xml\n<proposed_plan>\nexample\n</proposed_plan>\n```']){
  const entry:TranscriptEntry={id:'ordinary',at,card:{id:'ordinary',at,type:'message',content,status:'completed'}};
  assert.equal(conversationPlanEntry(entry,{planMode:true,live:false}),entry);
 }
});

test('legacy assistant messages with a plan are represented without leaking the body',()=>{
 const entry:TranscriptEntry={id:'legacy',at,message:{id:'legacy',role:'assistant',createdAt:at,text}};
 const projected=conversationPlanEntry(entry,{planMode:true,live:false});
 assert.equal(projected.card?.type,'plan_reference');assert.doesNotMatch(JSON.stringify(projected),/HIDDEN_PLAN_STEP/);
});

test('legacy completed plans stay saved during later turns, while unfinished tags do not claim success',()=>{
 const entry:TranscriptEntry={id:'legacy',at,card:{id:'legacy',at,type:'message',content:text,status:'completed'}};
 assert.deepEqual(conversationPlanEntry(entry,{planMode:true,live:true}).card?.data,{state:'saved'});
 entry.card!.content='<proposed_plan>\nHIDDEN_PLAN_STEP';
 assert.deepEqual(conversationPlanEntry(entry,{planMode:true,live:false}).card?.data,{state:'incomplete'});
});
