import {randomInt,createHash} from 'node:crypto';
import type {ModelProvider} from '../../web-agent/shared/contracts';
import type {AgentBackendRef,ExternalAgentId,ExternalAgentStatus} from '../../web-agent/shared/external-agents';
import {isCodexModelId} from './acp/codex-profile';
import {isCliModelId} from './acp/cli-profile';
import {providerConnection} from './provider-connection';
import {HttpError} from './store';

export type SpecialistExecutionOption = {id:string;agentName:string;modelName:string;execution:AgentBackendRef;explicitOnly?:true};
export type SpecialistExecutionChoice = {kind?:'native'|'acp';agent?:ExternalAgentId;modelId?:string;providerId?:string};
export function isExternalModelId(agent:ExternalAgentId,value:unknown):value is string {
  return agent==='codex'?isCodexModelId(value):isCliModelId(value);
}

/** Public configured metadata only: no model call, connection, credential read or permission grant. */
export function specialistExecutionOptions(providers:ModelProvider[],external:ExternalAgentStatus[]=[]):SpecialistExecutionOption[]{
  const rows:Omit<SpecialistExecutionOption,'id'>[]=[];
  for(const provider of providers){
    if(!provider.enabled||!provider.id||provider.id.length>256)continue;
    try{const connection=providerConnection(provider.protocol,provider.baseURL);if(!provider.keyConfigured&&!connection.localKeyPlaceholder)continue;}
    catch{continue;}
    for(const model of provider.models){
      if(!model.enabled||model.supportsImageOutput||!model.id||model.id.length>256||!model.name||model.name.length>256)continue;
      rows.push({agentName:'Lake 原生',modelName:model.name,execution:{kind:'native',model:{providerId:provider.id,modelId:model.id}}});
    }
  }
  for(const agent of external){
    if(!agent.enabled||!agent.installed||!agent.transportReady||!agent.assignmentReady)continue;
    const defaultModel=agent.modelOverride??agent.defaultTaskModel??agent.model;
    if(agent.id!=='codex'&&!defaultModel)rows.push({agentName:agent.name,modelName:'CLI 默认模型',execution:{kind:'acp',agent:agent.id}});
    for(const model of new Set([defaultModel,...agent.modelOptions??[]].filter(model=>isExternalModelId(agent.id,model)))){
      rows.push({agentName:agent.name,modelName:model,execution:{kind:'acp',agent:agent.id,model:{modelId:model}},
        ...(model!==defaultModel&&{explicitOnly:true})});
    }
  }
  return [...new Map(rows.map(row=>{
    const id=createHash('sha256').update(JSON.stringify(row.execution)).digest('hex');return [id,{...row,id}];
  })).values()].sort((a,b)=>a.id.localeCompare(b.id));
}

export function chooseSpecialistExecution(options:SpecialistExecutionOption[],choice:SpecialistExecutionChoice={},draw:(length:number)=>number=randomInt):AgentBackendRef{
  const candidates=options.filter(option=>{
    const backend=option.execution,model=backend.model;
    return (choice.modelId||!option.explicitOnly)&&(!choice.kind||backend.kind===choice.kind)&&(!choice.agent||backend.kind==='acp'&&backend.agent===choice.agent)&&
      (!choice.providerId||model?.providerId===choice.providerId)&&(!choice.modelId||model?.modelId===choice.modelId||option.modelName===choice.modelId);
  });
  if(!candidates.length)throw new HttpError(409,'没有符合要求且已配置可用的 Agent／模型，请先配置可用模型或连接 Agent');
  const groups=[...new Set(candidates.map(option=>option.execution.kind==='native'?'native':option.execution.agent))];
  const group=groups[draw(groups.length)],models=candidates.filter(option=>(option.execution.kind==='native'?'native':option.execution.agent)===group);
  return structuredClone(models[draw(models.length)].execution);
}
