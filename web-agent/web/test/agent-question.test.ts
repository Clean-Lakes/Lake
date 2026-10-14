import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {AgentQuestion} from "../src/AgentQuestion";
import {chooseAnswer,questionAnswer,questionOptions,recordQuestionAnswer} from "../src/questionState";
import {turnProgress,toolLabels} from "../src/activity";
import type {AIView} from "../../shared/contracts";
const question={id:"test-question",questions:[{id:"target",title:"选择目标",options:["测试","生产"]},{id:"checks",title:"选择检查项",options:["日志","指标"],multi_select:true}]};
test("question renders keyboard controls, free text and a submit action",()=>{
 const html=renderToStaticMarkup(createElement(AgentQuestion,{session:"fixture",request:question,refresh:async()=>{}}));
 assert.match(html,/选择目标/);assert.match(html,/type="radio"/);assert.match(html,/1\/2/);assert.match(html,/下一题/);assert.match(html,/textarea/);assert.match(html,/跳过/);assert.match(html,/暂不回答剩余问题/);
 assert.doesNotMatch(html,/checked=""/);
});
test("question waiting and all new tools have clear activity labels",()=>{
 assert.equal(turnProgress({status:"running",question} as AIView,[],"",Date.now()).activity?.text,"等待你的选择");
 for(const tool of ["todo_read","todo_write","ask_user_question","read_session_context","load_skill","list_workflows","get_workflow_run","run_workflow","save_workflow","schedule_create","schedule_list","schedule_update","schedule_delete","task_output","task_stop","read_tool_result"])assert.ok(toolLabels[tool],tool);
});

test("multi-select choices retain additional free text and single-choice Other replaces the selection",()=>{
 const multi=question.questions[1]!;
 let selected=chooseAnswer(multi,[],"日志");selected=chooseAnswer(multi,selected,"指标");
 assert.deepEqual(questionAnswer(multi,selected,"还检查磁盘",true),["日志","指标","还检查磁盘"]);
 assert.deepEqual(chooseAnswer(multi,selected,"日志"),["指标"]);
 assert.deepEqual(questionAnswer(question.questions[0]!,["测试"],"预发布",true),["预发布"]);
 assert.deepEqual(questionAnswer(question.questions[0]!,[],"",false),[]);
});
test("structured option descriptions and recommendations coexist with legacy labels",()=>{
 const item={id:"scope",title:"调查范围",options:[{label:"架构和 API",description:"梳理模块与接口",recommended:true},"核心日志"],multi_select:true};
 assert.equal(questionOptions(item)[0]?.description,"梳理模块与接口");
 const html=renderToStaticMarkup(createElement(AgentQuestion,{session:"fixture",request:{id:"rich",questions:[item]},refresh:async()=>{}}));
 assert.match(html,/梳理模块与接口/);assert.match(html,/推荐/);assert.match(html,/type="checkbox"/);
 const prior={target:["测试"]};const skipped=recordQuestionAnswer(prior,"scope",[]);
 assert.deepEqual(skipped,{target:["测试"],scope:[]});assert.deepEqual(prior,{target:["测试"]});
});
