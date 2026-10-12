import assert from "node:assert/strict";
import test from "node:test";
import {contextLabel,discoveredModels,providerDraft,providerPayload} from "../src/modelProviderState";
import type {ModelProvider} from "../../shared/contracts";

const provider:ModelProvider={id:"A",name:"Provider A",baseURL:"https://example.test/v1",protocol:"openai",enabled:true,keyConfigured:true,models:[{id:"model",name:"same-model",enabled:true,supportsImageInput:true,supportsImageOutput:false}]};
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
test("context badges distinguish explicit capacity from automatic detection",()=>{
 assert.equal(contextLabel(1000000),"1M");assert.equal(contextLabel(128000),"128K");assert.equal(contextLabel(),"自动");
});
