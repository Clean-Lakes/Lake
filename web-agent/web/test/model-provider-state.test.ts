import assert from "node:assert/strict";
import test from "node:test";
import {contextLabel,discoveredModels,providerDraft,providerPayload,providerProtocolBaseURL} from "../src/modelProviderState";
import type {ModelProvider} from "../../shared/contracts";

const provider:ModelProvider={id:"A",name:"Provider A",baseURL:"https://example.test/v1",protocol:"openai",enabled:true,keyConfigured:true,models:[{id:"model",name:"same-model",enabled:true,supportsImageInput:true,supportsImageOutput:false}]};
test("MiMo protocol changes keep official API prefixes aligned without changing proxy routes",()=>{
 assert.equal(providerProtocolBaseURL("https://api.xiaomimimo.com/v1","claude"),"https://api.xiaomimimo.com/anthropic/v1");
 assert.equal(providerProtocolBaseURL("https://api.xiaomimimo.com/anthropic/v1","openai"),"https://api.xiaomimimo.com/v1");
 assert.equal(providerProtocolBaseURL("https://token-plan-cn.xiaomimimo.com/v1","claude"),"https://token-plan-cn.xiaomimimo.com/anthropic/v1");
 for(const raw of ["https://proxy.example.test/v1","https://api.xiaomimimo.com.attacker.test/v1","https://api.xiaomimimo.com/custom/v1","http://127.0.0.1:1234/v1"]) assert.equal(providerProtocolBaseURL(raw,"claude"),raw);
});
test("saved keys are never copied into drafts and blank updates preserve only the selected provider",()=>{
 const a=providerDraft(provider),b=providerDraft({...provider,id:"B",name:"Provider B"});
 a.apiKey="synthetic-new-key";
 assert.equal(b.apiKey,"");assert.equal("apiKey" in providerPayload(b),false);
 assert.equal(providerPayload(a).apiKey,"synthetic-new-key");
 a.clearKey=true;assert.equal(providerPayload(a).apiKey,null);
 b.models[0]!.name="changed";assert.equal(provider.models[0]!.name,"same-model");
});
test("discovery adds unique model IDs without losing local capability edits",()=>{
 const models=discoveredModels(provider.models,["same-model","another","another",""]);
 assert.equal(models.length,2);assert.equal(models[0]?.supportsImageInput,true);
 assert.equal(models[1]?.name,"another");assert.notEqual(models[1]?.id,"model");
});
test("discovery uses image metadata only for automatic capability mode",()=>{
 const current=[
  {id:"auto",name:"vision",enabled:true,supportsImageInput:false,supportsImageOutput:false,imageInputMode:"auto" as const},
  {id:"manual",name:"text",enabled:true,supportsImageInput:true,supportsImageOutput:false,imageInputMode:"on" as const},
 ];
 const models=discoveredModels(current,["vision","text","new"],{vision:true,text:false,new:false});
 assert.equal(models[0]?.imageInputDetected,true);
 assert.equal(models[0]?.supportsImageInput,true);
 assert.equal(models[1]?.supportsImageInput,true);
 assert.equal(models[2]?.imageInputMode,"auto");
 assert.equal(models[2]?.imageInputDetected,false);
});
test("discovery retains provider reasoning levels for saved model settings",()=>{
 const models=discoveredModels([], ["reasoner"], {}, {reasoner:{levels:["low","high"],default:"low",source:"provider"}});
 assert.deepEqual(models[0]?.reasoningCapability?.levels,["low","high"]);
 assert.deepEqual(providerPayload({...providerDraft(provider),models}).models[0]?.reasoningCapability,models[0]?.reasoningCapability);
});
test("context badges distinguish explicit capacity from automatic detection",()=>{
 assert.equal(contextLabel(1000000),"1M");assert.equal(contextLabel(128000),"128K");assert.equal(contextLabel(),"自动");
});

test("API import adds only selected IDs and keeps the existing model's local settings",()=>{
 const current=[{...provider.models[0]!,imageInputMode:"on" as const,contextWindow:64000}];
 const models=discoveredModels(current,["selected-model"],{"same-model":false,"selected-model":true,"not-selected":true},{"selected-model":{levels:["low","high"],source:"provider"}},{"selected-model":128000,"not-selected":256000});
 assert.equal(models.length,2);
 assert.deepEqual(models[0],current[0]);
 assert.equal(models[1]?.name,"selected-model");
 assert.equal(models[1]?.contextWindow,128000);
 assert.equal(models[1]?.imageInputDetected,true);
 assert.deepEqual(models[1]?.reasoningCapability?.levels,["low","high"]);
 assert.equal(models.some(model => model.name==="not-selected"),false);
});
test("API import preserves explicit local context and skips invalid API context values",()=>{
 const current=[{...provider.models[0]!,contextWindow:64000}];
 const models=discoveredModels(current,["same-model","too-large","fractional","valid"],{}, {},{"same-model":128000,"too-large":10000000,"fractional":8192.5,valid:8192});
 assert.equal(models[0]?.contextWindow,64000);
 assert.equal(models[1]?.contextWindow,0);
 assert.equal(models[2]?.contextWindow,0);
 assert.equal(models[3]?.contextWindow,8192);
});
