import test from 'node:test';
import assert from 'node:assert/strict';
import type {ModelProvider} from '../../web-agent/shared/contracts';
import type {ExternalAgentStatus} from '../../web-agent/shared/external-agents';
import {chooseSpecialistExecution,specialistExecutionOptions} from './specialist-execution';

const provider=(id='one'):ModelProvider=>({id,name:id,baseURL:'https://example.invalid/v1',protocol:'openai',enabled:true,keyConfigured:true,
  models:[{id:'a',name:'native-a',enabled:true,supportsImageInput:false,supportsImageOutput:false},
    {id:'b',name:'gpt-6.1-sol',enabled:true,supportsImageInput:true,supportsImageOutput:false}]});
const codex=(patch:Partial<ExternalAgentStatus>={}):ExternalAgentStatus=>({id:'codex',projectId:'p',name:'Codex',revision:1,enabled:true,installed:true,transportReady:true,assignmentReady:true,model:'gpt-6.1-sol',updatedAt:'2026-11-12T00:00:00Z',...patch});
const group=(execution:{kind:string;agent?:string})=>execution.kind==='native'?'native':execution.agent;

test('specialist pool contains only configured text models and the ready pinned Codex model',()=>{
  const normal=provider(),disabled={...provider('disabled'),enabled:false},missing={...provider('no-key'),keyConfigured:false};
  const unsupported={...provider('unsupported'),protocol:'not-an-adapter'},badURL={...provider('invalid-url'),baseURL:'https://user:password@example.invalid'};
  normal.models.push({...normal.models[0],id:'off',enabled:false},{...normal.models[0],id:'image',supportsImageOutput:true});
  const options=specialistExecutionOptions([normal,disabled,missing,unsupported,badURL],[codex()]);
  assert.equal(options.length,3);assert.equal(new Set(options.map(option=>option.id)).size,3);
  assert.ok(options.every(option=>option.execution.model));
  assert.equal(JSON.stringify(options).includes('password'),false);assert.equal(JSON.stringify(options).includes('baseURL'),false);
  for(const agent of [codex({enabled:false}),codex({assignmentReady:false}),codex({model:'unverified-model'})])
    assert.equal(specialistExecutionOptions([],[agent]).length,0);
  assert.equal(specialistExecutionOptions([{...provider('ollama'),protocol:'ollama',keyConfigured:false}]).length,2);
});

test('random defaults draw the Agent first and then a compatible model without weighting Agents by model count',()=>{
  const options=specialistExecutionOptions([provider()],[codex()]);
  const groups=[...new Set(options.map(option=>group(option.execution)))];
  const lengths:number[]=[];
  const selected=chooseSpecialistExecution(options,{},length=>{lengths.push(length);return lengths.length===1?groups.indexOf('codex'):length-1;});
  assert.equal(selected.kind,'acp');assert.equal(selected.model?.modelId,'gpt-6.1-sol');assert.deepEqual(lengths,[2,1]);
  const native=options.filter(option=>option.execution.kind==='native');
  for(let index=0;index<native.length;index++){
    let draw=0;const actual=chooseSpecialistExecution(options,{},()=>++draw===1?groups.indexOf('native'):index);
    assert.deepEqual(actual,native[index].execution);
  }
});

test('explicit Agent, model-only, exact provider and full selection restrict missing random choices',()=>{
  const options=specialistExecutionOptions([provider('one'),provider('two')],[codex()]);
  assert.equal(chooseSpecialistExecution(options,{kind:'acp',agent:'codex'},()=>0).kind,'acp');
  assert.equal(chooseSpecialistExecution(options,{kind:'native'},n=>n-1).kind,'native');
  const candidates=options.filter(option=>option.modelName==='gpt-6.1-sol'),groups=[...new Set(candidates.map(option=>group(option.execution)))];
  for(const expected of groups){let draw=0;const chosen=chooseSpecialistExecution(options,{modelId:'gpt-6.1-sol'},()=>++draw===1?groups.indexOf(expected):0);assert.equal(group(chosen),expected);}
  assert.deepEqual(chooseSpecialistExecution(options,{providerId:'two',modelId:'native-a'},()=>0),{kind:'native',model:{providerId:'two',modelId:'a'}});
  for(const choice of [{kind:'acp' as const,modelId:'native-a'},{modelId:'nonexistent'},{providerId:'missing'},{kind:'native' as const,agent:'codex' as const}])
    assert.throws(()=>chooseSpecialistExecution(options,choice),/没有符合要求/);
});

test('empty pools fail before drawing and selected references never alias catalog entries',()=>{
  assert.throws(()=>chooseSpecialistExecution([],{},()=>{throw Error('must not draw');}),/没有符合要求/);
  const options=specialistExecutionOptions([provider()]),before=JSON.stringify(options),selected=chooseSpecialistExecution(options,{},()=>0);
  selected.model!.modelId='changed';assert.equal(JSON.stringify(options),before);
  assert.deepEqual(specialistExecutionOptions([provider(),provider()]),options,'duplicate metadata does not weight random selection');
});
