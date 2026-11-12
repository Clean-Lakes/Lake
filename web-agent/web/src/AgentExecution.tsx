import type {AgentExecutionSummary} from '../../shared/external-agents';
import {agentBackendName} from '../../shared/external-agents';
import {agentExecutionPresentation,externalRunPresentation} from './agentExecutionState';
import {ExecutionAgentIcon} from './ExecutionAgentIcon';
import {Glyph} from './Icons';

export function AgentExecution({execution,roleName,waiting=false,onInspect,compact=false}:{execution?:AgentExecutionSummary;roleName?:string;waiting?:boolean;onInspect?:()=>void;compact?:boolean}){
 if(!execution)return null;
 const {backend,runs}=execution,state=agentExecutionPresentation(execution,waiting);
 return <section className={`agent-execution${compact?' is-compact':''}`} aria-label="Agent 分配与回传" data-execution-agent={backend.kind==='acp'?backend.agent:'native'}>
  <div className="agent-execution-top"><div className="agent-execution-chain">{roleName&&<><span title={roleName}>{roleName}</span><Glyph name="chevron" size={12}/></>}<span>任务 Worker</span><Glyph name="chevron" size={12}/><span className="agent-execution-target"><ExecutionAgentIcon agent={backend.kind==='acp'?backend.agent:undefined} size={15}/><strong>{agentBackendName(backend)}</strong>{backend.kind==='acp'&&<small>ACP</small>}</span></div>
   <span className="agent-execution-status" data-tone={state.tone}><Glyph name={state.icon} size={12}/>{state.label}</span>
  </div>
  {runs.length>0&&<details className="agent-execution-runs"><summary><span>执行记录与回传</span><small>{execution.totalRuns} 次</small></summary><div className="agent-execution-run-list">{runs.map(run=>{
   const status=externalRunPresentation(run,waiting),report=run.summary||run.error;
   return <article className="agent-execution-run" key={run.id} data-run-id={run.id}>
    <header><ExecutionAgentIcon agent={run.agent} size={15}/><strong>{agentBackendName({kind:'acp',agent:run.agent})}</strong><small>{run.scope==='child'?'子 Agent':run.scope==='worker'?'任务执行':'受委派执行'}</small><span className="agent-execution-status" data-tone={status.tone}>{status.label}</span></header>
    {report?<p className="external-execution-report">{report}</p>:<p className="agent-execution-empty">{['starting','running'].includes(run.state)?'等待 Agent 回传…':'本次未返回报告。'}</p>}
    <footer><time dateTime={run.updatedAt}>{new Date(run.updatedAt).toLocaleString('zh-CN',{hour12:false})}</time><span>{run.usage?`输入 ${run.usage.inputTokens} · 输出 ${run.usage.outputTokens} token`:'外部用量未报告'}</span></footer>
   </article>;
  })}{execution.totalRuns>runs.length&&<p className="agent-execution-empty">显示最近 {runs.length} 次，完整记录保留在任务执行过程中。</p>}</div></details>}
  <div className="agent-execution-foot"><small>{runs.length?'进度与回传来自实际运行记录。':backend.kind==='acp'?'分配已记录，尚无外部执行记录。':'当前任务使用 Lake 原生执行上下文。'}</small>{onInspect&&<button type="button" onClick={onInspect}>查看任务<Glyph name="chevron" size={12}/></button>}</div>
 </section>;
}
