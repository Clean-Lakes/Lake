import assert from "node:assert/strict";
import test from "node:test";
import type {AvailableModelEntry,AvailableModels} from "../../shared/contracts";
import {currentComposerModel} from "../src/composerModelState";
import {modelBrand} from "../src/modelBrand";

const magpie:AvailableModelEntry={providerId:"magpie",providerName:"Magpie",modelId:"route/opaque-model",name:"route/opaque-model",displayName:"Claude Sonnet · 区域路由"};
const manual:AvailableModelEntry={...magpie,providerId:"manual",providerName:"Manual",modelId:"local-model",displayName:"Private Alias"};
const available:AvailableModels={models:[magpie.name,manual.name],entries:[magpie,manual],activeProviderId:magpie.providerId,activeModelId:magpie.modelId};
test("Magpie opaque routes display their supplied label and manufacturer before opening the menu",()=>{
 const selected=currentComposerModel({models:[]},magpie.name,magpie);
 assert.equal(selected?.displayName,magpie.displayName);
 assert.equal(modelBrand(selected!.name,selected!.displayName,selected!.providerName),"anthropic");
});
test("the selected provider takes precedence over the first row for identical model names",()=>{
 assert.deepEqual(currentComposerModel(available,manual.name,manual),manual);
 assert.deepEqual(currentComposerModel({...available,activeProviderId:"manual",activeModelId:"local-model"},manual.name),manual);
 assert.equal(modelBrand(manual.name,manual.displayName,manual.providerName),"custom");
});
test("stale metadata cannot attach an unrelated display name to the current model",()=>{
 assert.equal(currentComposerModel(available,"xiaomi/mimo-v2.6-pro",magpie),undefined);
 assert.equal(currentComposerModel({...available,activeProviderId:"missing",activeModelId:"missing"},magpie.name),undefined);
 assert.deepEqual(currentComposerModel({models:[magpie.name],entries:[magpie]},magpie.name),magpie);
});
