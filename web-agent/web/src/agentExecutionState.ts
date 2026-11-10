import {agentBackendName,type AgentExecutionSummary,type ExternalAgentRunSummary} from '../../shared/external-agents';

export function externalRunPresentation(run:ExternalAgentRunSummary,waiting=false){
 const name=agentBackendName({kind:'acp',agent:run.agent});
 if(run.state==='completed')return {label:`${name} 已回传`,tone:'returned',icon:'check'};
 if(run.state==='unknown')return {label:`${name} 结果待核实`,tone:'attention',icon:'alert'};
 if(run.state==='failed')return {label:`${name} 执行失败`,tone:'attention',icon:'alert'};
 if(run.state==='cancelled'||run.state==='interrupted')return {label:`${name} 已停止`,tone:'stopped',icon:'stop'};
 if(waiting)return {label:`${name} 等待确认`,tone:'attention',icon:'clock'};
 if(run.dispatchPhase==='not_sent')return {label:`正在连接 ${name}`,tone:'active',icon:'loader'};
 return {label:`${name} 执行中`,tone:'active',icon:'loader'};
}
export function agentExecutionPresentation(execution:AgentExecutionSummary,waiting=false){
 const run=[...execution.runs].reverse().find(run=>run.scope==='worker')??execution.runs.at(-1);
 if(run)return externalRunPresentation(run,waiting);
 return execution.backend.kind==='acp'?{label:`${agentBackendName(execution.backend)} 尚未派发`,tone:'pending',icon:'clock'}:
  {label:'Lake 原生执行',tone:'native',icon:'lakeWorkflow'};
}
