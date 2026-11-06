import {useState,type ReactNode} from 'react';
import type {AICard,AgentRun,SessionSnapshot,SuperWorker} from '../../shared/contracts';
import {DisclosureSummary} from './DisclosureSummary';
import {Glyph,ResourceIcon} from './Icons';
import {ToolStep} from './ThinkingTimeline';
import {executionCard,nativeRunState,needsExecutionAttention,workerBusinessReceipts,workerExecutionModel,type WorkerExecutionNode} from './workerExecutionModel';
import './workerExecutionTree.css';

const labels:Record<string,string>={queued:'排队中',running:'执行中',background_running:'后台执行中',pending:'等待确认',waiting_approval:'等待确认',waiting_input:'等待补充',waiting_external:'等待外部结果',paused:'已暂停',blocked:'结果待核实',completed:'已完成',succeeded:'已完成',success:'已完成',failed:'执行失败',cancelled:'已停止',interrupted:'已中断',not_executed:'未执行',unknown:'结果待核实'};
const time=(value?:string)=>value?new Date(value).toLocaleTimeString('zh-CN',{hour12:false}):'';
const duration=(run:AgentRun)=>{
 if(!run.startedAt||!run.finishedAt)return '';
 const seconds=Math.max(0,Math.round((Date.parse(run.finishedAt)-Date.parse(run.startedAt))/1000));
 return Number.isFinite(seconds)?seconds<60?`${seconds}秒`:`${Math.floor(seconds/60)}分${seconds%60}秒`:'';
};
function State({status}:{status:string}){return <span className="worker-execution-state" data-state={status}><Glyph name={['completed','succeeded','success'].includes(status)?'check':['running','background_running'].includes(status)?'loader':['failed','unknown','pending','waiting_approval','waiting_input'].includes(status)?'alert':['cancelled','interrupted'].includes(status)?'stop':'clock'} size={13}/>{labels[status]??'状态待核实'}</span>}
function Branch({children,summary,active=false,className=''}:{children:ReactNode;summary:ReactNode;active?:boolean;className?:string}){
 const [open,setOpen]=useState(active);
 return <details className={`worker-execution-branch ${className}`} open={open} onToggle={event=>setOpen(event.currentTarget.open)}><DisclosureSummary>{summary}</DisclosureSummary>{children}</details>;
}
function Calls({cards,paths}:{cards:AICard[];paths:Map<string,string>}){
 const calls=cards.filter(executionCard);
 if(!calls.length)return null;
 return <ol className="thinking-steps worker-execution-calls">{calls.map(card=>{
  const data=card.data&&typeof card.data==='object'?card.data as Record<string,unknown>:{};
  const path=typeof data.resource_id==='string'?paths.get(data.resource_id):undefined;
  return <ToolStep key={card.id} card={path?{...card,data:{...data,target:path}}:card} active={card.status==='running'}/>;
 })}</ol>;
}
function Child({run,paths}:{run:AgentRun;paths:Map<string,string>}){
 const calls=(run.cards??[]).filter(executionCard),elapsed=duration(run),status=nativeRunState(run);
 return <Branch active={needsExecutionAttention(status)} className="worker-child-run" summary={<><Glyph name="layers" size={15}/><span className="worker-execution-name" title={run.task}>{run.name||run.task||'临时子智能体'}</span><small className="worker-execution-meta">{elapsed||`${run.toolCount??calls.length} 次调用`}</small><State status={status}/></>}>
  <div className="worker-child-detail">
   <p className="worker-child-created"><Glyph name="clock" size={12}/><time dateTime={run.createdAt}>{time(run.createdAt)}</time>创建子智能体</p>
   {run.task&&run.task!==run.name&&<p className="worker-child-assignment">{run.task}</p>}
   {run.resourceIds.length>1&&<div className="worker-child-resources" aria-label="涉及资源">{run.resourceIds.map(id=><span key={id} title={paths.get(id)??id}><Glyph name="link" size={11}/>{paths.get(id)??id}</span>)}</div>}
   <Calls cards={calls} paths={paths}/>
   {!calls.length&&<p className="worker-execution-empty">{['running','queued'].includes(run.status)?'等待实际工具记录。':'本次没有资源工具记录。'}</p>}
   {run.summary&&<p className="worker-child-result">{run.summary}</p>}
   {run.finishedAt&&<p className="worker-child-created"><Glyph name={status==='unknown'?'alert':run.status==='completed'?'check':'clock'} size={12}/><time dateTime={run.finishedAt}>{time(run.finishedAt)}</time>{status==='unknown'?'执行结束，结果待核实':labels[run.status]??'执行结束'}</p>}
  </div>
 </Branch>;
}
function ResourceBranch({node,paths}:{node:WorkerExecutionNode;paths:Map<string,string>}){
 return <Branch active={needsExecutionAttention(node.state)} className={`worker-resource-${node.kind}`} summary={<>{node.resource?<ResourceIcon kind={node.resource.kind} size={15}/>:<Glyph name="folder" size={15}/>}<span className="worker-execution-name" title={node.path}>{node.name}</span><State status={node.state}/></>}>
  <div className="worker-execution-children">{node.children.map(child=><ResourceBranch key={child.id} node={child} paths={paths}/>)}{node.runs.map(run=><Child key={run.id} run={run} paths={paths}/>)}<Calls cards={node.cards} paths={paths}/></div>
 </Branch>;
}
export function WorkerExecutionTree({snapshot,worker}:{snapshot:SessionSnapshot;worker?:SuperWorker}){
 const task=snapshot.superagent?.task;
 const model=workerExecutionModel(snapshot);
 if(!task)return null;
 const status=task.state==='waiting_user'?'waiting_input':task.state;
 const identity=worker?.task.taskId===task.taskId?worker.id:undefined;
 const active=model.runs.filter(run=>needsExecutionAttention(run.status)&&run.status!=='failed'&&run.status!=='unknown').length;
 const unresolved=model.runs.filter(run=>nativeRunState(run)==='unknown').length;
 return <section className="worker-execution-tree" aria-label="任务执行过程" data-worker-id={identity}>
  <header className="worker-execution-root"><Glyph name="lakeWorkflow" size={19}/><strong>任务 Worker</strong><small>由 Lake 分配</small><State status={status}/></header>
  {model.runs.length>0&&<p className="worker-execution-caption">临时子智能体 · {model.runs.length}{active>0&&<span>{active} 个需要跟进</span>}</p>}
  <div className="worker-execution-trunk">
   {model.resources.map(node=><ResourceBranch key={node.id} node={node} paths={model.resourcePaths}/>)}
   {(model.taskRuns.length>0||model.taskCards.length>0)&&<section className="worker-task-records" aria-label="任务级执行"><h4><Glyph name="lakeProcess" size={15}/>{model.resources.length?'跨资源与任务级过程':'任务执行过程'}</h4>{model.taskRuns.map(run=><Child key={run.id} run={run} paths={model.resourcePaths}/>)}<Calls cards={model.taskCards} paths={model.resourcePaths}/></section>}
   {!model.resources.length&&!model.taskRuns.length&&!model.taskCards.length&&<p className="worker-execution-empty">执行工具后，记录会按资源显示在这里。</p>}
  </div>
  {model.runs.length>0&&<footer className="worker-execution-footer"><Glyph name="layers" size={13}/>{unresolved>0?`${unresolved} 个子智能体存在待核实结果`:active>0?'子智能体执行状态会持续更新。':`${model.runs.length} 个子智能体均已结束`}<span>任务验收以实际结果为准</span></footer>}
 </section>;
}

export function WorkerExecutionResults({snapshot}:{snapshot:SessionSnapshot}){
 const task=snapshot.superagent?.task,model=workerExecutionModel(snapshot);
 if(!task)return null;
 const cards=workerBusinessReceipts(snapshot);
 return <section className="worker-execution-results" aria-label="任务结果与证据">
  {task.summary?<p className="worker-task-report">{task.summary}</p>:<p className="inspector-empty">{task.state==='cancelled'?'此任务已停止，未提交完成结果。':'任务结果尚未提交。'}</p>}
  <Branch summary={<><Glyph name="document" size={15}/><span className="worker-execution-name">业务工具回执</span><small>{cards.length} 项</small></>}><Calls cards={cards} paths={model.resourcePaths}/></Branch>
 </section>;
}
