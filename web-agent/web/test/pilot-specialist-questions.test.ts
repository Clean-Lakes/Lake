import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PilotSpecialistQuestions} from '../src/PilotSpecialistQuestions';
import type {SpecialistQuestion} from '../../shared/contracts';

const questions:SpecialistQuestion[]=['发布专员','数据专员'].map((name,index)=>({
 author:{kind:'specialist',name,roleId:'role-'+index,workerId:'worker-'+index,sessionId:'session-'+index,taskId:'task-'+index,avatarId:index?'beaver':'heron'},
 taskTitle:index?'验证测试库':'复制测试配置',request:{id:'question-'+index,questions:[{id:'source',title:index?'使用哪个测试库？':'从哪个测试环境复制？'}]},
}));
test('Pilot displays every original specialist question with its own name, avatar and task',()=>{
 const html=renderToStaticMarkup(createElement(PilotSpecialistQuestions,{questions,connected:true,onAnswered:async()=>{}}));
 for(const item of questions){
  assert.ok(html.includes(`aria-label="${item.author.name}的问题"`));
  assert.ok(html.includes(`<strong>${item.author.name}</strong>`));
  assert.ok(html.includes(item.taskTitle)&&html.includes(item.request.questions[0]!.title));
  assert.ok(html.includes(`data-role="${item.author.avatarId}"`));
 }
 assert.equal((html.match(/class="response-avatar"/g)??[]).length,2);
 assert.doesNotMatch(html,/<strong>Lake<\/strong>|执行详情|打开任务/);
 assert.doesNotMatch(html,/<fieldset[^>]*disabled/);
});
test('disconnected Pilot keeps questions visible but disables their original forms',()=>{
 const html=renderToStaticMarkup(createElement(PilotSpecialistQuestions,{questions,connected:false,onAnswered:async()=>{}}));
 assert.equal((html.match(/class="pilot-specialist-question" disabled=""/g)??[]).length,2);
 assert.ok(html.includes('从哪个测试环境复制？'));
 for(const values of [undefined,[]])assert.equal(renderToStaticMarkup(createElement(PilotSpecialistQuestions,{questions:values,connected:true,onAnswered:async()=>{}})),'');
});
