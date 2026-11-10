import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ComposerModelSelect,type ComposerModelSelectProps} from '../src/ComposerModelSelect';
import {agentBackendName} from '../../shared/external-agents';

// Closed selector rendering must also work in the native panel's separate page.
Object.defineProperty(globalThis,'document',{configurable:true,value:{documentElement:{dataset:{theme:'light'}}}});
Object.defineProperty(globalThis,'window',{configurable:true,value:{}});
const props:ComposerModelSelectProps={available:{models:['gpt-6.1-terra'],entries:[{providerId:'provider',providerName:'Saved Codex provider',modelId:'gpt-6.1-terra',name:'gpt-6.1-terra',displayName:'gpt-6.1-terra'}],loading:false},modelName:'gpt-6.1-terra',configured:true,open:false,disabled:false,onOpenChange:()=>{},onSelect:()=>{},onSettings:()=>{}};

test('a specialist configured for Codex shows the actual Agent in the existing model trigger',()=>{
 const html=renderToStaticMarkup(createElement(ComposerModelSelect,{...props,externalAgent:{selected:true,ready:true}}));
 assert.match(html,/aria-label="选择模型：Codex · 独立 Agent"/);assert.match(html,/composer-model-name">Codex<\/span>/);
 assert.doesNotMatch(html,/执行分配|协调模型|agent-assignment-control/);
});
test('Codex remains selectable without a separate Lake inference model credential',()=>{
 const html=renderToStaticMarkup(createElement(ComposerModelSelect,{...props,available:{models:[],loading:false},configured:false,modelName:null,externalAgent:{selected:true,ready:false,message:'请先配置 Codex'}}));
 assert.match(html,/选择模型：Codex/);assert.doesNotMatch(html,/composer-model-setup/);assert.match(html,/title="请先配置 Codex"/);
});
test('a native model choice retains its actual model without labeling it an independent Agent',()=>{
 const html=renderToStaticMarkup(createElement(ComposerModelSelect,{...props,externalAgent:{selected:false,ready:true}}));
 assert.match(html,/composer-model-name">gpt-6.1-terra<\/span>/);assert.doesNotMatch(html,/aria-label="选择模型：Codex · 独立 Agent"/);
});
test('Pilot Codex configuration keeps its native model and cannot select the specialist executor',()=>{
 const html=renderToStaticMarkup(createElement(ComposerModelSelect,{...props,externalAgent:{selected:false,ready:false,message:'本机 Codex 尚未登录',configurationOnly:true}}));
 assert.match(html,/composer-model-name">gpt-6.1-terra<\/span>/);
 assert.doesNotMatch(html,/独立 Agent|value="__lake_codex_agent__"/);
});
test('an unconfigured Pilot still connects its own model when Codex only supplies project settings',()=>{
 const html=renderToStaticMarkup(createElement(ComposerModelSelect,{...props,configured:false,externalAgent:{selected:false,ready:true,configurationOnly:true}}));
 assert.match(html,/composer-model-setup/);assert.match(html,/连接模型/);
 assert.doesNotMatch(html,/独立 Agent|value="__lake_codex_agent__"/);
});
test('a model provider named Codex cannot impersonate an independent Codex selection',()=>{
 const html=renderToStaticMarkup(createElement(ComposerModelSelect,props));
 assert.doesNotMatch(html,/独立 Agent|value="__lake_codex_agent__"/);assert.match(html,/gpt-6.1-terra/);
});
test('retired external bindings remain identifiable in history without advertising a supported Agent',()=>{
 assert.equal(agentBackendName({kind:'acp',agent:'runtime-acp',revision:1}),'已移除的 Agent');
});
