import {randomInt,createHash} from 'node:crypto';
import type {ModelProvider} from '../../web-agent/shared/contracts';
import type {AgentBackendRef,ExternalAgentStatus} from '../../web-agent/shared/external-agents';
import {codexModels} from './acp/codex-profile';
import {providerConnection} from './provider-connection';
import {HttpError} from './store';

export type SpecialistExecutionOption = {id:string;agentName:string;modelName:string;execution:AgentBackendRef};
export type SpecialistExecutionChoice = {kind?:'native'|'acp';agent?:'codex';modelId?:string;providerId?:string};

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
    // The ready probe identifies the compatible local model without guessing
    // entitlement from every model name in the ordinary Lake model menu.
    if(agent.id!=='codex'||!agent.enabled||!agent.installed||!agent.transportReady||!agent.assignmentReady||!agent.model||!codexModels.includes(agent.model))continue;
    rows.push({agentName:'Codex',modelName:agent.model,execution:{kind:'acp',agent:'codex',model:{modelId:agent.model}}});
  }
  return [...new Map(rows.map(row=>{
    const id=createHash('sha256').update(JSON.stringify(row.execution)).digest('hex');return [id,{...row,id}];
  })).values()].sort((a,b)=>a.id.localeCompare(b.id));
}

export function chooseSpecialistExecution(options:SpecialistExecutionOption[],choice:SpecialistExecutionChoice={},draw:(length:number)=>number=randomInt):AgentBackendRef{
  const candidates=options.filter(option=>{
    const backend=option.execution,model=backend.model!;
    return (!choice.kind||backend.kind===choice.kind)&&(!choice.agent||backend.kind==='acp'&&backend.agent===choice.agent)&&
      (!choice.providerId||model.providerId===choice.providerId)&&(!choice.modelId||model.modelId===choice.modelId||option.modelName===choice.modelId);
  });
  if(!candidates.length)throw new HttpError(409,'没有符合要求且已配置可用的 Agent／模型，请先配置可用模型或连接 Agent');
  const groups=[...new Set(candidates.map(option=>option.execution.kind==='native'?'native':option.execution.agent))];
  const group=groups[draw(groups.length)],models=candidates.filter(option=>(option.execution.kind==='native'?'native':option.execution.agent)===group);
  return structuredClone(models[draw(models.length)].execution);
}
