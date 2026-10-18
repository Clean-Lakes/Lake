import {Glyph} from './Icons';
import {AppSelect} from "./AppSelect";
import {useCallback, useEffect, useRef, useState} from "react";
import type {Project, Resource, WorkflowCatalog, WorkflowInput, WorkflowRun, WorkflowStep, WorkflowTemplate} from "../../shared/contracts";
import {api, readableError} from "./api";
import {AgentIcon} from "./AgentIcon";
import {agentStatusLabels} from "./agentTasks";
import "./workflows.css";

const identities = {host:{name:"调查员",label:"主机调查"},application:{name:"调查员",label:"应用日志"},data:{name:"调查员",label:"数据库 / Redis"}};
const statuses = {running:"执行中",completed:"已完成",failed:"失败",cancelled:"已停止",interrupted:"已中断"};
const allowed = (role:WorkflowStep["role"], resource:Resource) => role === "data" ? ["database","redis"].includes(resource.kind) : ["local","ssh"].includes(resource.kind);
const newStep = ():WorkflowStep => ({id:crypto.randomUUID(),role:"host",task:"",resourceIds:[]});
const emptyDraft = ():WorkflowInput => ({name:"",goal:"",steps:[newStep()]});

export function Workflows({project,resources,modelConfigured,onClose,onOpenRun}:{project:Project;resources:Resource[];modelConfigured:boolean;onClose:()=>void;onOpenRun:(run:WorkflowRun)=>void|Promise<void>}) {
 const [sreEnabled,setSREEnabled]=useState(false);
 const [catalog,setCatalog]=useState<WorkflowCatalog>({templates:[],runs:[]});
 const [draft,setDraft]=useState<WorkflowInput>(emptyDraft);
 const [selected,setSelected]=useState<string|null>(null);
 const [busy,setBusy]=useState("");const [error,setError]=useState("");const [loading,setLoading]=useState(true);
 const [deleting,setDeleting]=useState<string|null>(null);
 const closeRef=useRef<HTMLButtonElement>(null);
 const reload=useCallback(async(signal?:AbortSignal)=>{const [data,sre]=await Promise.all([api.workflows(project.id,signal),api.getSREEnabled(project.id,signal)]);if(!signal?.aborted){setCatalog(data);setSREEnabled(sre.enabled);}},[project.id]);
 useEffect(()=>{const controller=new AbortController();closeRef.current?.focus();void reload(controller.signal).catch(cause=>{if(!controller.signal.aborted)setError(readableError(cause));}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[reload]);
 useEffect(()=>{const controller=new AbortController();const timer=window.setInterval(()=>{void reload(controller.signal).catch(cause=>{if(!controller.signal.aborted)setError(readableError(cause));});},3000);return()=>{clearInterval(timer);controller.abort();};},[reload]);
 useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!busy){event.preventDefault();onClose();}};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[onClose,busy]);
 const edit=(template?:WorkflowTemplate)=>{setSelected(template?.id||null);setDraft(template?{name:template.name,goal:template.goal,version:template.version,steps:template.steps.map(step=>({...step,resourceIds:[...step.resourceIds]}))}:emptyDraft());setError("");setDeleting(null);};
 const update=(id:string,changes:Partial<WorkflowStep>)=>setDraft(current=>({...current,steps:current.steps.map(step=>step.id===id?{...step,...changes}:step)}));
 const move=(index:number,direction:number)=>setDraft(current=>{const steps=[...current.steps];const to=index+direction;if(to<0||to>=steps.length)return current;[steps[index],steps[to]]=[steps[to]!,steps[index]!];return {...current,steps};});
 const work=async(label:string,task:()=>Promise<void>)=>{setBusy(label);setError("");try{await task();}catch(cause){setError(readableError(cause));}finally{setBusy("");}};
 const save=async(run=false)=>work("save",async()=>{
  const saved=await api.saveWorkflow(project.id,draft,selected||undefined);edit(saved);await reload();
  if(run){const started=await api.runWorkflow(project.id,saved.id,saved.version);await onOpenRun(started);}
 });
 const valid=!!draft.name.trim()&&!!draft.goal.trim()&&draft.steps.every(step=>step.task.trim()&&step.resourceIds.length>0&&step.resourceIds.every(id=>resources.some(resource=>resource.id===id&&allowed(step.role,resource))));
 return <div className="modal-scrim workflow-scrim"><section className="workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-title">
  <header className="workflow-header"><div><h2 id="workflow-title">运维工作流</h2><p>{project.name} · 自定义调查目标与步骤</p></div><button ref={closeRef} type="button" className="button secondary" aria-label="关闭运维工作流" onClick={onClose} disabled={!!busy}>关闭</button></header>
  {!loading&&!sreEnabled&&<p className="workflow-note" role="status">运行前，请在本项目的会话中开启 SRE 协作。</p>}
  {error&&<p className="workflow-error" role="alert">{error}</p>}
  <div className="workflow-layout"><aside className="workflow-library" aria-label="工作流模板与记录"><div className="workflow-section-head"><strong>模板</strong><button type="button" className="button secondary" disabled={!!busy} onClick={()=>edit()}>新建模板</button></div>
   {loading?<p role="status">正在加载…</p>:!catalog.templates.length?<p className="workflow-empty">保存第一个模板后，可以重复运行。</p>:catalog.templates.map(template=><article className={`workflow-template ${selected===template.id?"selected":""}`} key={template.id}><button type="button" className="workflow-template-name" disabled={!!busy} onClick={()=>edit(template)}><strong>{template.name}</strong><span>{template.steps.length} 个调查步骤 · SRE 协调汇总</span></button><div className="workflow-template-actions"><button type="button" disabled={!!busy||!modelConfigured||!sreEnabled||catalog.runs.some(run=>run.workflowId===template.id&&run.status==="running")} onClick={()=>void work("run",async()=>{const run=await api.runWorkflow(project.id,template.id,template.version);await onOpenRun(run);})}>运行</button><button type="button" disabled={!!busy} onClick={()=>setDeleting(template.id)}>删除</button></div>{deleting===template.id&&<div className="workflow-delete"><span>删除模板，保留执行记录。</span><button type="button" disabled={!!busy} onClick={()=>void work("delete",async()=>{await api.deleteWorkflow(project.id,template.id,template.version);if(selected===template.id)edit();setDeleting(null);await reload();})}>确认删除</button><button type="button" onClick={()=>setDeleting(null)}>取消</button></div>}</article>)}
   <div className="workflow-section-head workflow-history-head"><strong>执行记录</strong></div>{!catalog.runs.length&&<p className="workflow-empty">每次运行都会创建独立会话。</p>}{catalog.runs.map(run=>{const completed=(run.agentRuns||[]).filter(agent=>agent.status==="completed"&&agent.role!=="verify").length;const current=(run.agentRuns||[]).find(agent=>["running","queued","waiting_approval"].includes(agent.status));return <article className="workflow-history" key={run.id}><div><strong>{run.template.name}</strong><span className={`workflow-run-state state-${run.status}`}>{run.waitingApproval?"等待确认":statuses[run.status]}</span></div><p>{completed} / {run.template.steps.length} 个调查步骤{current?` · ${current.name} ${agentStatusLabels[current.status]||current.status}`:""}</p><small>{new Date(run.createdAt).toLocaleString()}</small>{run.error&&<p className="workflow-history-error">{run.error}</p>}<div className="workflow-template-actions"><button type="button" disabled={!!busy} onClick={()=>void work("open",async()=>{await onOpenRun(run);})}>查看执行</button>{run.status==="running"&&<button type="button" disabled={!!busy} onClick={()=>void work("stop",async()=>{await api.cancelWorkflow(project.id,run.id);await reload();})}>停止工作流</button>}</div></article>;})}
  </aside><form className="workflow-editor" onSubmit={event=>{event.preventDefault();void save();}}>
   <div className="workflow-section-head"><strong>{selected?"编辑模板":"新建模板"}</strong>{draft.version&&<small>版本 {draft.version}</small>}</div>
   <label>模板名称<input required maxLength={120} value={draft.name} disabled={!!busy} onChange={event=>setDraft(current=>({...current,name:event.target.value}))} placeholder="例如：应用资源异常调查"/></label>
   <label>总目标<textarea required rows={2} maxLength={1000} value={draft.goal} disabled={!!busy} onChange={event=>setDraft(current=>({...current,goal:event.target.value}))} placeholder="希望得到什么结论？例如：定位内存占用异常的原因，并列出证据和处理建议。"/></label>
   <div className="workflow-steps-head"><strong>调查步骤</strong><span>按顺序执行 · 前步结果传给后步</span></div>
   <ol className="workflow-steps">{draft.steps.map((step,index)=>{const identity=identities[step.role];return <li className="workflow-step" key={step.id}><div className="workflow-step-head"><span className="workflow-step-number">{index+1}</span><AgentIcon role="investigator"/><strong>{identity.name}</strong><span>{identity.label}</span><div className="workflow-step-order"><button type="button" aria-label={`上移步骤 ${index+1}`} disabled={!!busy||index===0} onClick={()=>move(index,-1)}><Glyph name="up" size={14}/></button><button type="button" aria-label={`下移步骤 ${index+1}`} disabled={!!busy||index===draft.steps.length-1} onClick={()=>move(index,1)}><Glyph name="down" size={14}/></button><button type="button" aria-label={`删除步骤 ${index+1}`} disabled={!!busy||draft.steps.length===1} onClick={()=>setDraft(current=>({...current,steps:current.steps.filter(item=>item.id!==step.id)}))}><Glyph name="close" size={14}/></button></div></div>
    <label>调查领域<AppSelect value={step.role} disabled={!!busy} onChange={event=>update(step.id,{role:event.target.value as WorkflowStep["role"],resourceIds:[]})}>{Object.entries(identities).map(([role,item])=><option key={role} value={role}>{item.name} · {item.label}</option>)}</AppSelect></label>
    <label>步骤目标<textarea required rows={2} maxLength={1000} value={step.task} disabled={!!busy} onChange={event=>update(step.id,{task:event.target.value})} placeholder={step.role==="application"?"例如：检查 /var/log/app.log 中的错误，与前一步异常对照。":step.role==="data"?"例如：检查数据库连接数和活动，判断是否异常。":"例如：检查 CPU、内存与主要进程，定位资源占用。"}/></label>
    <fieldset><legend>目标资源（最多 3 个）</legend><div className="workflow-resources">{resources.filter(resource=>allowed(step.role,resource)).map(resource=><label key={resource.id}><input type="checkbox" checked={step.resourceIds.includes(resource.id)} disabled={!!busy||!step.resourceIds.includes(resource.id)&&step.resourceIds.length>=3} onChange={event=>update(step.id,{resourceIds:event.target.checked?[...step.resourceIds,resource.id]:step.resourceIds.filter(id=>id!==resource.id)})}/><span>{resource.name}</span><small>{resource.kind}</small></label>)}{!resources.some(resource=>allowed(step.role,resource))&&<p>项目内暂无适合此 Agent 的资源，请先添加资源。</p>}</div></fieldset>
   </li>;})}</ol>
   <button type="button" className="button secondary workflow-add-step" disabled={!!busy||draft.steps.length>=7} onClick={()=>setDraft(current=>({...current,steps:[...current.steps,newStep()]}))}>＋ 添加步骤 <small>{draft.steps.length} / 7</small></button>
   <div className="workflow-finish"><AgentIcon role="coordinator"/><div><strong>SRE 调查员 → 协调者汇总</strong><p>专员按步骤使用会话工具并保留真实证据；失败或停止会暂停后续步骤。</p></div></div>
   <p className="workflow-note">工作流由 SRE 专员执行，继承会话的工具能力和审批规则。调查任务保持只读目标；变更通过对话中的 SRE Plan 安排。</p>
   <footer className="workflow-editor-actions"><button type="submit" className="button secondary" disabled={!!busy||!valid}>{busy==="save"?"正在保存…":"保存模板"}</button><button type="button" className="button primary" disabled={!!busy||!valid||!modelConfigured||!sreEnabled} title={modelConfigured?"按当前模板启动 SRE 专员":"请先配置 Agent 模型"} onClick={()=>void save(true)}>保存并运行</button></footer>
  </form></div>
 </section></div>;
}
