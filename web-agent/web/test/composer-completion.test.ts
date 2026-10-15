import assert from "node:assert/strict";
import test from "node:test";
import {completionEligible,localCompletion,validCompletion} from "../src/composerCompletion";

test("completion only runs for focused drafts with a collapsed caret at the end",()=>{
 const text="帮我检查";
 assert.equal(completionEligible(text,4,4,true,false,false),true);
 for(const args of [[text,2,2,true,false,false],[text,0,4,true,false,false],[text,4,4,false,false,false],[text,4,4,true,true,false],[text,4,4,true,false,true],["帮我",2,2,true,false,false],["检查完成。",5,5,true,false,false],["api_key=synthetic",17,17,true,false,false]] as const) assert.equal(completionEligible(...args),false);
});
test("local fallback favors current-session history while keeping the typed prefix intact",()=>{
 assert.equal(localCompletion("帮我检查",["帮我检查 CPU 使用率","帮我检查 Redis 主从状态"])," Redis 主从状态");
 assert.equal(localCompletion("check",["Check Nginx logs"])," Nginx logs");
 assert.equal(localCompletion("帮我检查",[]),"服务运行状态，分析异常原因并给出处理建议。");
 assert.equal(localCompletion("未知前缀",[]),"");
});
test("history and generated suffixes cannot introduce broken mentions, multiline replies, or empty output",()=>{
 assert.equal(localCompletion("请帮我",["请帮我 @生产主机 检查日志","请帮我\n运行脚本"]),"排查服务无法访问的原因。");
 for(const value of [null,"","   ","\nanswer","@server","x".repeat(121)]) assert.equal(validCompletion(value),false);
 assert.equal(validCompletion(" logs"),true);
});
