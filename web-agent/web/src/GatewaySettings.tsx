import {useCallback,useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {GatewayCommand,GatewayConnection,GatewayConnections,GatewayInstructionTask,GatewayMessage,GatewayMessagePage,GatewayRouting,LakeEventSourceUpdate,SessionSnapshot} from '../../shared/contracts';
import {api,readableError} from './api';
import {AppSelect} from './AppSelect';
import {DisclosureSummary} from './DisclosureSummary';
import {GrafanaEventSource} from './GrafanaEventSource';
import {Glyph} from './Icons';

export type GatewayTaskTarget = {projectId:string;sessionId:string;taskId:string;roleId:string};
export function gatewayTaskTarget(message:GatewayMessage,task:GatewayInstructionTask):GatewayTaskTarget|undefined {
  if(!message.tasks.includes(task)||!task.sessionId||!task.roleId)return;
  return {projectId:message.projectId,sessionId:task.sessionId,taskId:task.taskId,roleId:task.roleId};
}
export function gatewayTaskMatches(snapshot:SessionSnapshot,target:GatewayTaskTarget){
  const task=snapshot.superagent?.task;
  return snapshot.session.id===target.sessionId&&snapshot.session.projectId===target.projectId&&snapshot.superagent?.roleId===target.roleId&&
    !!task&&(task.taskId===target.taskId||task.executionGoalId===target.taskId)&&task.sessionId===target.sessionId;
}
export function gatewayCommandSnippet(command:GatewayCommand|undefined,tokenId:string,roleId?:string){
  return [command?.program??'lake',command?.script,'--mcp-specialist','--home',command?.home??'~/.lake',command?.data?['--data',command.data]:[],roleId?['--role',roleId]:[],'--token-id',tokenId]
    .flat().filter(Boolean).map(part=>/\s/.test(String(part))?`"${part}"`:String(part)).join(' ');
}
/** JSON keeps executable/arguments separate, including spaces and shell metacharacters. */
export function gatewayClientConfig(command:GatewayCommand,connection:Pick<GatewayConnection,'id'>){
  const args=[...(command.script?[command.script]:[]),'--mcp-channel','--home',command.home,...(command.data?['--data',command.data]:[]),'--connection',connection.id];
  return JSON.stringify({mcpServers:{[`lake-${connection.id}`]:{command:command.program,args}}},null,2);
}
export function gatewayTaskProgress(task:GatewayInstructionTask){
  if(task.waitingApproval)return '等待在 Lake 确认';
  if(task.waitingInput)return '等待补充信息';
  if(task.goalState==='cancelled')return '已停止';
  if(task.goalState==='failed')return '执行失败';
  if(task.goalState==='completed')return '报告已提交';
  if(task.activity?.label)return task.activity.label;
  if(task.state==='queued')return '等待处理';
  if(task.state==='active')return '正在处理';
  return ({paused:'已暂停',blocked:'暂时受阻',waiting_external:'等待外部结果',waiting_user:'等待补充信息'} as Record<string,string>)[task.goalState]??'等待进展';
}
export function gatewayDeliveryText(message:GatewayMessage){
  const reports=new Set(message.replies.filter(reply=>reply.taskId&&message.tasks.some(task=>task.taskId===reply.taskId&&task.goalState==='completed')).map(reply=>reply.taskId)).size;
  const states:Record<GatewayMessage['state'],string>={routing:'Pilot 正在路由',routed:'消息已路由',running:'仍在处理',waiting_approval:'等待在 Lake 确认',waiting_input:'等待补充信息',replied:'回复可在原会话读取',failed:'本次处理失败',blocked:'本次处理受阻',stopped:'本次处理已停止'};
  return message.tasks.length?`已收到 ${reports} / ${message.tasks.length} 份报告 · ${states[message.state]}`:states[message.state];
}
export function mergeGatewayMessages(pages:GatewayMessage[][]){
  const seen=new Set<string>();return pages.flat().filter(message=>{if(seen.has(message.instructionId))return false;seen.add(message.instructionId);return true;});
}
/** A switched/unmounted connection must never publish a late page or fetch more of its history. */
export async function readGatewayMessagePages(read:(cursor?:string)=>Promise<GatewayMessagePage>,count:number,signal:AbortSignal):Promise<GatewayMessagePage>{
  const pages:GatewayMessage[][]=[];let cursor:string|undefined;
  for(let page=0;page<count;page++){
    signal.throwIfAborted();const result=await read(cursor);signal.throwIfAborted();
    pages.push(result.messages);cursor=result.nextCursor;if(!cursor)break;
  }
  return {messages:mergeGatewayMessages(pages),...(cursor?{nextCursor:cursor}:{})};
}
function conversationMemberLabel(state:string){return ({queued:'等待回应',running:'正在回应',replied:'已回应',failed:'回应失败',timed_out:'回应超时',cancelled:'已停止',interrupted:'回应中断'} as Record<string,string>)[state]??state;}
function time(value?:string){if(!value)return '暂无消息';const date=new Date(value);return Number.isNaN(date.getTime())?'时间未知':date.toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});}
function routing(value:string):GatewayRouting{return value==='pilot'?{mode:'pilot'}:{mode:'specialist',roleId:value};}

export function GatewayMessageTree({message,connectionName,onTask,disabled=false}:{message:GatewayMessage;connectionName:string;onTask?:(target:GatewayTaskTarget)=>void;disabled?:boolean}){
  return <article className="gateway-message-tree" aria-label={`消息：${message.text}`}>
    <div className="gateway-source-message"><Glyph name="chat" size={18}/><div><div className="gateway-source-meta"><strong>{connectionName}</strong><span>会话：{message.threadTitle||message.threadId}</span><time dateTime={message.createdAt}>{time(message.createdAt)}</time></div><p>{message.text}</p></div></div>
    {message.tasks.length>0&&<div className="gateway-linked-tasks"><p className="gateway-routing-note">Pilot 已关联 {message.tasks.length} 项任务</p><ul>{message.tasks.map(task=>{
      const target=gatewayTaskTarget(message,task),progress=gatewayTaskProgress(task);
      return <li key={`${task.taskId}:${task.sessionId}`}><Glyph name="listTasks" size={16}/><strong className="gateway-task-title">{task.title}</strong><span className="gateway-task-owner">{task.roleName||'Pilot'}</span><span className={`gateway-task-progress ${task.goalState==='completed'?'reported':''}`}>{progress}</span><button className="provider-text-button" type="button" disabled={disabled||!target||!onTask} onClick={()=>target&&onTask?.(target)} aria-label={`查看任务：${task.title}`}>查看任务<Glyph name="next" size={14}/></button><p className="gateway-task-description">{task.summary||task.activity?.label||progress}</p></li>;
    })}</ul></div>}
    {!!message.conversations?.length&&<section className="gateway-discussions" aria-label="对话回应"><h5>对话回应</h5>{message.conversations.map(conversation=><div key={conversation.id}><strong>{conversation.title}</strong><ul>{conversation.members.map(member=><li key={member.id}><span>{member.roleName}</span><small>{conversationMemberLabel(member.state)}{member.reason?` · ${member.reason}`:''}</small></li>)}</ul>{message.replies.filter(reply=>reply.conversationId===conversation.id&&reply.from==='specialist').map((reply,index)=><p className="gateway-pilot-reply" key={`${reply.createdAt}:${index}`}><strong>{reply.roleName||'专员回应'}</strong>{reply.text}</p>)}</div>)}</section>}
    {message.replies.filter(reply=>reply.from==='pilot').map((reply,index)=><p className="gateway-pilot-reply" key={`${reply.createdAt}:${index}`}><strong>Pilot</strong>{reply.text}</p>)}
    {message.error&&<p className="form-error">{message.error}</p>}
    <p className="gateway-delivery"><Glyph name="return" size={14}/>{gatewayDeliveryText(message)}</p>
  </article>;
}

export function GatewayMessageList({messages,expanded=false,connectionName,onTask,disabled=false}:{messages:GatewayMessage[];expanded?:boolean;connectionName:string;onTask?:(target:GatewayTaskTarget)=>void;disabled?:boolean}){
  return <div id="gateway-message-history">{(expanded?messages:messages.slice(0,1)).map(message=><GatewayMessageTree key={message.instructionId} message={message} connectionName={connectionName} onTask={onTask} disabled={disabled}/>)}</div>;
}

function GatewayMessages({connection,onTask,disabled,onReceipt}:{connection:GatewayConnection;onTask?:(target:GatewayTaskTarget)=>void;disabled:boolean;onReceipt:(connectionId:string,at:string)=>void}){
  const [messages,setMessages]=useState<GatewayMessage[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[nextCursor,setNextCursor]=useState<string>();
  const [expanded,setExpanded]=useState(false);
  const receipt=useRef(onReceipt);receipt.current=onReceipt;
  const controller=useRef<AbortController|undefined>(undefined),flight=useRef(false),pages=useRef(1),alive=useRef(true);
  const load=useCallback(async()=>{
    if(flight.current&&!controller.current?.signal.aborted)return;flight.current=true;const cancel=new AbortController();controller.current=cancel;
    try{const result=await readGatewayMessagePages(cursor=>api.gatewayMessages(connection.id,cursor,cancel.signal),pages.current,cancel.signal);
      if(!alive.current||cancel.signal.aborted)return;const rows=result.messages;setMessages(rows);setNextCursor(result.nextCursor);setError('');const latest=rows.map(row=>row.createdAt).sort().at(-1);if(latest)receipt.current(connection.id,latest);
    }catch(cause){if(alive.current&&!cancel.signal.aborted)setError(readableError(cause));}
    finally{if(controller.current===cancel)flight.current=false;if(alive.current&&!cancel.signal.aborted)setLoading(false);}
  },[connection.id]);
  useEffect(()=>{alive.current=true;void load();const timer=window.setInterval(()=>{if(!document.hidden)void load();},3000);return()=>{alive.current=false;controller.current?.abort();window.clearInterval(timer);};},[load]);
  const toggleHistory=()=>{setExpanded(value=>!value);if(expanded){pages.current=1;controller.current?.abort();void load();}};
  return <section className="gateway-messages" aria-labelledby="gateway-messages-title">
    <div className="gateway-section-heading">
      <div>
        <h2 id="gateway-messages-title" className="workspace-section-title">消息与任务</h2>
        {connection.lastReceivedAt&&<p className="gateway-receipt">最近收件 <time dateTime={connection.lastReceivedAt}>{time(connection.lastReceivedAt)}</time></p>}
      </div>
      <div className="gateway-history-actions">
        {(messages.length>1||nextCursor||expanded)&&<button className="provider-text-button" type="button" aria-expanded={expanded} aria-controls="gateway-message-history" onClick={toggleHistory}>{expanded?'收起历史消息':'查看全部消息'}<Glyph name={expanded?'up':'next'} size={13}/></button>}
        <button className="provider-text-button" type="button" disabled={loading} onClick={()=>void load()}><Glyph name="refresh" size={13}/>刷新</button>
      </div>
    </div>
    {loading&&<p className="settings-note" role="status">正在读取消息与任务…</p>}
    {error&&<div className="gateway-message-error" role="alert"><p className="form-error">{error}</p><button type="button" className="provider-text-button" onClick={()=>void load()}>重试</button></div>}
    {!loading&&!error&&!messages.length&&<div className="gateway-empty gateway-empty-state workspace-setting-card">
      <Glyph name="chat" size={19}/>
      <div><h3>还没收到消息</h3><p>将接入配置添加到外部客户端，再从那里发送第一条消息。</p></div>
    </div>}
    <GatewayMessageList messages={messages} expanded={expanded} connectionName={connection.name} onTask={onTask} disabled={disabled}/>
    {expanded&&nextCursor&&<button className="provider-text-button gateway-load-more" type="button" disabled={loading} onClick={()=>{if(flight.current)return;pages.current++;setLoading(true);void load();}}>加载更多消息<Glyph name="down" size={13}/></button>}
  </section>;
}

type Management = 'actions'|'config'|'rename'|'delete';

export function GatewaySettings({actionsHost,onBusyChange,projectId,onTask}:{actionsHost:HTMLElement|null;onBusyChange:(value:boolean)=>void;projectId?:string;onTask?:(target:GatewayTaskTarget)=>Promise<void>}){
  const [catalog,setCatalog]=useState<GatewayConnections>(),[selected,setSelected]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[error,setError]=useState(''),[feedback,setFeedback]=useState('');
  const [creating,setCreating]=useState(false),[name,setName]=useState(''),[project,setProject]=useState(projectId??''),[route,setRoute]=useState('pilot');
  const [credential,setCredential]=useState<{sourceId:string;token:string}>();
  const [legacyDeleteId,setLegacyDeleteId]=useState('');
  const [management,setManagement]=useState<Management|null>(null),[newName,setNewName]=useState('');
  const mounted=useRef(true),flight=useRef(false),cancelLoad=useRef<AbortController|undefined>(undefined),nameInput=useRef<HTMLInputElement>(null);
  const addButton=useRef<HTMLButtonElement>(null),manageButton=useRef<HTMLButtonElement>(null);
  const selectedRef=useRef(selected);selectedRef.current=selected;
  const connection=catalog?.connections.find(entry=>entry.id===selected);
  const source=catalog?.eventSources?.find(entry=>entry.id===selected);
  const entries=[...(catalog?.connections??[]),...(catalog?.eventSources??[])];
  const current=source??connection;
  const projectName=catalog?.projects.find(entry=>entry.id===current?.projectId)?.name??'原项目不可用';
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;cancelLoad.current?.abort();};},[]);
  useEffect(()=>{onBusyChange(!!busy);return()=>onBusyChange(false);},[busy,onBusyChange]);
  const load=useCallback(async()=>{cancelLoad.current?.abort();const cancel=new AbortController();cancelLoad.current=cancel;
    try {
      const data=await api.gatewayConnections(cancel.signal);
      if(!mounted.current||cancel.signal.aborted)return;
      setCatalog(data);
      const available=[...data.connections,...(data.eventSources??[])];
      setSelected(current=>available.some(entry=>entry.id===current)?current:available[0]?.id??'');
      setProject(current=>data.projects.some(entry=>entry.id===current)?current:data.projects[0]?.id??'');
    }
    finally{if(mounted.current&&!cancel.signal.aborted)setLoading(false);}
  },[]);
  useEffect(()=>{void load().catch(cause=>{if(mounted.current)setError(readableError(cause));});},[load]);
  useEffect(()=>{setManagement(null);},[selected]);
  useEffect(()=>{if(creating||management==='rename')nameInput.current?.focus();},[creating,management]);
  async function run<T>(key:string,work:()=>Promise<T>,message:string,refresh=true){
    if(flight.current)return;flight.current=true;setBusy(key);setError('');setFeedback('');
    try{const value=await work();if(refresh)await load();if(mounted.current){setFeedback(message);return value;}}
    catch(cause){if(mounted.current)setError(readableError(cause));try{await load();}catch{}return undefined;}
    finally{flight.current=false;if(mounted.current)setBusy('');}
  }
  const update=(value:{name?:string;enabled?:boolean;routing?:GatewayRouting})=>connection&&run('save',()=>api.updateGatewayConnection(connection.id,{...value,expectedUpdatedAt:connection.updatedAt}),'连接已更新');
  const create=async()=>{
    const result=await run('create',()=>api.createGatewayConnection({name:name.trim(),projectId:project,routing:routing(route)}),'连接已创建，复制接入配置到外部客户端即可使用');
    if(!result)return;
    setSelected(result.id);
    setCreating(false);
    setName('');
    setRoute('pilot');
  };
  const updateSource=async(value:LakeEventSourceUpdate)=>{
    if(!source)return;
    const result=await run('event-source',()=>api.updateEventSource(source.id,value),'来源已更新',false);
    if(!result)return;
    setCatalog(current=>current&&{
      ...current,eventSources:current.eventSources?.map(entry=>entry.id===source.id?result.source:entry),
    });
    if(result.token)setCredential({sourceId:source.id,token:result.token});
  };
  async function copy(value:string,connectionId?:string){
    try {
      await navigator.clipboard.writeText(value);
      if(mounted.current&&(!connectionId||selectedRef.current===connectionId)){
        setError('');
        setFeedback(connectionId?'接入配置已复制':'旧命令已复制');
      }
    } catch {
      if(!mounted.current||(connectionId&&selectedRef.current!==connectionId))return;
      if(connectionId)setManagement('config');
      setError(connectionId?'无法写入剪贴板，请手动复制接入配置。':'无法写入剪贴板。');
      setFeedback('');
    }
  }
  const inspect=async(target:GatewayTaskTarget)=>{if(!onTask||flight.current)return;flight.current=true;setBusy('task');setError('');try{await onTask(target);}catch(cause){if(mounted.current)setError(readableError(cause));}finally{flight.current=false;if(mounted.current)setBusy('');}};
  const available=catalog?.specialists.filter(role=>role.projectId===(creating?project:connection?.projectId))??[];
  const selectRouting=(value:string,change:(value:string)=>void)=><AppSelect label="处理方式" value={value} disabled={!!busy} onChange={event=>change(event.target.value)}>
    <option value="pilot">Pilot 自动路由</option>
    {available.map(role=><option key={role.roleId} value={role.roleId}>固定专员：{role.name}</option>)}
    {value!=='pilot'&&!available.some(role=>role.roleId===value)&&<option value={value}>原专员不可用</option>}
  </AppSelect>;
  function openCreate() {
    if(creating){nameInput.current?.focus();return;}
    setCreating(true);setManagement(null);setName('');setRoute('pilot');setCredential(undefined);setError('');setFeedback('');
  }
  function closeCreate() {
    setCreating(false);
    setError('');
    setFeedback('');
    addButton.current?.focus();
  }
  function closeManagement() {
    setManagement(null);
    manageButton.current?.focus();
  }
  function selectConnection(id:string) {
    setSelected(id);
    setCredential(undefined);
    setLegacyDeleteId('');
    setError('');
    setFeedback('');
  }
  const addConnection=<button ref={addButton} type="button" className="button primary" aria-label="添加连接" title="添加连接"
    disabled={loading||!!busy} onClick={openCreate}><Glyph name="plus" size={15}/><span>添加连接</span></button>;
  const currentRouting=connection?.routing.mode==='specialist'?connection.routing.roleId:'pilot';

  return <section id="channels-settings-panel" role="tabpanel" aria-labelledby="channels-settings-tab" className="gateway-settings"
    onKeyDown={event=>{
      if(event.key!=='Escape'||busy||event.defaultPrevented||!(creating||management||legacyDeleteId))return;
      event.preventDefault();
      event.stopPropagation();
      if(creating)closeCreate();
      else if(legacyDeleteId)setLegacyDeleteId('');
      else closeManagement();
    }}>
    {actionsHost&&createPortal(addConnection,actionsHost)}
    {error&&<div className="gateway-feedback" role="alert">
      <p className="form-error">{error}</p>
      {!catalog&&<button type="button" className="button secondary" disabled={loading} onClick={()=>{
        setError('');setLoading(true);void load().catch(cause=>setError(readableError(cause)));
      }}>重新读取</button>}
    </div>}
    <p className="gateway-feedback settings-note" role="status">{busy?'正在处理…':feedback}</p>

    {creating?<section className="gateway-section" aria-labelledby="gateway-create-title">
      <div className="gateway-section-heading">
        <h2 id="gateway-create-title" className="workspace-section-title">新建连接</h2>
      </div>
      <form className="gateway-create gateway-setting-group workspace-setting-card" onSubmit={event=>{event.preventDefault();void create();}}>
        <div className="workspace-setting-row">
          <div className="workspace-setting-copy"><label htmlFor="gateway-new-name">连接名称</label></div>
          <input id="gateway-new-name" className="gateway-name-input" ref={nameInput} value={name} onChange={event=>setName(event.target.value)}
            maxLength={120} autoComplete="off" placeholder="我的 Codex" disabled={!!busy}/>
        </div>
        <div className="workspace-setting-row">
          <div className="workspace-setting-copy">
            <strong>所属项目</strong>
            {!catalog?.projects.length&&<p className="settings-note">请先在工作区创建项目。</p>}
          </div>
          <AppSelect label="所属项目" value={project} disabled={!!busy} onChange={event=>{setProject(event.target.value);setRoute('pilot');}}>
            {catalog?.projects.map(entry=><option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </AppSelect>
        </div>
        <div className="workspace-setting-row">
          <div className="workspace-setting-copy"><strong>处理方式</strong></div>
          {selectRouting(route,setRoute)}
        </div>
        <div className="workspace-setting-row gateway-form-actions">
          <button className="button secondary" type="button" disabled={!!busy} onClick={closeCreate}>取消</button>
          <button className="button primary" type="submit" disabled={!!busy||!name.trim()||!project}>{busy==='create'?'创建中…':'创建连接'}</button>
        </div>
      </form>
    </section>:current&&catalog?<>
      <section className="gateway-section" aria-labelledby="gateway-connection-title">
        <div className="gateway-section-heading">
          <h2 id="gateway-connection-title" className="workspace-section-title">连接设置</h2>
        </div>
        <div className="gateway-setting-group workspace-setting-card">
          <div className="workspace-setting-row">
            <div className="workspace-setting-copy">
              <strong>当前连接</strong>
              <p className="settings-note">
                {source?'Grafana':'MCP'} · <span className="visually-hidden">所属项目 </span>{projectName}
              </p>
            </div>
            {entries.length>1?<AppSelect label="切换连接" title={current.name}
              value={selected} renderValue={current.name} disabled={!!busy} onChange={event=>selectConnection(event.target.value)}>
              {entries.map(entry=><option key={entry.id} value={entry.id}>
                {entry.name} · {'kind' in entry?'Grafana':'MCP'} · {catalog.projects.find(item=>item.id===entry.projectId)?.name??'原项目不可用'}
              </option>)}
            </AppSelect>:<span className="gateway-current-name">
              <Glyph name={source?'grafana':'plug'} size={16}/>{current.name}
            </span>}
          </div>
          <div className="workspace-setting-row">
            <div className="workspace-setting-copy">
              <strong>启用接入</strong>
              <p className="settings-note">{source?'接收来自 Grafana 的告警。':'接收来自此外部客户端的消息。'}</p>
            </div>
            <div className="gateway-connection-status">
              <span>{current.enabled?'已启用':'已停用'}</span>
              <button type="button" role="switch" aria-checked={current.enabled}
                aria-label={source?`启用来源 ${current.name}`:`启用连接 ${current.name}`}
                className={`provider-switch ${current.enabled?'on':''}`} disabled={!!busy}
                onClick={()=>{if(source)void updateSource({expectedRevision:source.revision,enabled:!source.enabled});else if(connection)void update({enabled:!connection.enabled});}}><span/></button>
            </div>
          </div>
          {connection&&!source&&<div className="workspace-setting-row gateway-routing">
            <div className="workspace-setting-copy">
              <strong>处理方式</strong>
              <p className="settings-note">{connection.routing.mode==='pilot'?'Pilot 根据消息内容回复、追问或分派任务。':
                available.some(role=>role.roleId===currentRouting)?'将新消息交给所选专员。':'原专员不可用，请选择新的处理方式。'}</p>
            </div>
            {selectRouting(currentRouting,value=>void update({routing:routing(value)}))}
          </div>}
        </div>
      </section>
      {connection&&!source&&<section className="gateway-section" aria-labelledby="gateway-config-title">
        <div className="gateway-section-heading">
          <h2 id="gateway-config-title" className="workspace-section-title">接入配置</h2>
          <button ref={manageButton} className="provider-text-button" type="button" disabled={!!busy}
            aria-expanded={!!management} aria-controls={management?'gateway-management':undefined}
            onClick={()=>setManagement(management?null:'actions')}><Glyph name="more" size={17}/>管理连接</button>
        </div>
        <div className="gateway-setting-group workspace-setting-card">
          <div className="workspace-setting-row">
            <div className="workspace-setting-copy">
              <strong>客户端配置</strong>
              <p className="settings-note">将配置加入外部客户端的 MCP 设置。</p>
            </div>
            <button className="button secondary" type="button" disabled={!!busy}
              onClick={()=>void copy(gatewayClientConfig(catalog.command,connection),connection.id)}><Glyph name="copy" size={15}/>复制接入配置</button>
          </div>
          <div className="workspace-setting-row">
            <div className="workspace-setting-copy">
              <strong>连通性检查</strong>
              <p className="settings-note">检查当前连接是否可用。</p>
            </div>
            <button className="button secondary" type="button" disabled={!!busy||!connection.enabled} onClick={()=>{
              void run('test',()=>api.testGatewayConnection(connection.id),'').then(result=>{
                if(result&&mounted.current&&selectedRef.current===connection.id)setFeedback(result.message);
              });
            }}><Glyph name={busy==='test'?'loader':'plug'} size={15}/>测试接入</button>
          </div>
          {management&&<section id="gateway-management" className="gateway-management" aria-label="连接管理">
            <div className="gateway-manage-actions">
              <button className="provider-text-button" type="button" disabled={!!busy} aria-expanded={management==='config'}
                onClick={()=>setManagement(management==='config'?'actions':'config')}><Glyph name="code" size={15}/>查看接入配置</button>
              <button className="provider-text-button" type="button" disabled={!!busy} aria-expanded={management==='rename'}
                onClick={()=>{setNewName(connection.name);setManagement('rename');}}><Glyph name="edit" size={14}/>重命名</button>
              <button className="provider-text-button danger-text" type="button" disabled={!!busy} aria-expanded={management==='delete'}
                onClick={()=>setManagement('delete')}><Glyph name="trash" size={14}/>删除连接</button>
            </div>
            {management==='config'&&<pre className="gateway-config" tabIndex={0} aria-label="接入配置 JSON">{gatewayClientConfig(catalog.command,connection)}</pre>}
            {management==='rename'&&<form className="gateway-management-form" onSubmit={event=>{
              event.preventDefault();void update({name:newName.trim()})?.then(result=>{if(result)setManagement('actions');});
            }}>
              <label className="field-label">连接名称<input ref={nameInput} value={newName} onChange={event=>setNewName(event.target.value)} maxLength={120} disabled={!!busy}/></label>
              <div className="gateway-form-actions">
                <button className="button secondary" type="button" disabled={!!busy} onClick={closeManagement}>取消</button>
                <button className="button primary" type="submit" disabled={!!busy||!newName.trim()||newName.trim()===connection.name}>保存名称</button>
              </div>
            </form>}
            {management==='delete'&&<div className="gateway-management-form" role="group" aria-label="确认删除连接">
              <p>删除「{connection.name}」后将立即拒绝新接入，原消息及任务记录保留。</p>
              <div className="gateway-form-actions">
                <button type="button" autoFocus className="button secondary" disabled={!!busy} onClick={closeManagement}>取消</button>
                <button type="button" className="button secondary danger-text" disabled={!!busy}
                  onClick={()=>void run('delete',()=>api.deleteGatewayConnection(connection.id),'连接已删除，原任务记录保留')}>确认删除</button>
              </div>
            </div>}
          </section>}
        </div>
      </section>}
    </>:!error&&<section className="gateway-empty-state workspace-setting-card" aria-labelledby="gateway-list-title">
      <Glyph name="plug" size={19}/>
      <div><h2 id="gateway-list-title" className="workspace-section-title">我的连接</h2>
        {loading?<p className="settings-note" role="status">正在读取接入渠道…</p>:
          <p className="settings-note">添加一个连接，接收外部客户端的消息。</p>}
      </div>
      {!actionsHost&&!loading&&addConnection}
    </section>}

    {!creating&&source&&<GrafanaEventSource key={source.id} source={source}
      token={credential?.sourceId===source.id?credential.token:undefined}
      disabled={!!busy} onUpdate={value=>void updateSource(value)} onDismissToken={()=>setCredential(undefined)}
      onReceipt={at=>setCatalog(current=>{
        if(!current||current.eventSources?.find(entry=>entry.id===source.id)?.lastReceivedAt===at)return current;
        return {...current,eventSources:current.eventSources?.map(entry=>entry.id===source.id?{...entry,lastReceivedAt:at}:entry)};
      })}/>}
    {!creating&&connection&&!source&&<GatewayMessages key={connection.id} connection={connection} onTask={target=>void inspect(target)} disabled={!!busy}
      onReceipt={(id,at)=>setCatalog(current=>current?{...current,connections:current.connections.map(entry=>entry.id===id&&(!entry.lastReceivedAt||entry.lastReceivedAt<at)?{...entry,lastReceivedAt:at}:entry)}:current)}/>}
    {!creating&&!!catalog?.legacyTokens.length&&<details className="gateway-legacy">
      <DisclosureSummary>兼容接入 · {catalog.legacyTokens.length}</DisclosureSummary>
      <p>原单专员配置继续使用原权限范围。</p>
      {catalog.legacyTokens.map(token=><div key={token.id}>
        <strong>{token.name}</strong>
        <small>{token.roles?.length?`限定 ${token.roles.length} 位专员`:'原全部专员范围'}</small>
        <button className="provider-text-button" type="button" onClick={()=>void copy(gatewayCommandSnippet(catalog.command,token.id,token.roles?.length===1?token.roles[0]:undefined))}>复制旧命令<Glyph name="copy" size={13}/></button>
        <button type="button" className="provider-text-button danger-text" disabled={!!busy} onClick={()=>setLegacyDeleteId(token.id)}>删除旧凭据</button>
        {legacyDeleteId===token.id&&<div className="gateway-legacy-confirm" role="group" aria-label={`确认删除旧凭据 ${token.name}`}>
          <p>删除后原连接立即失效，任务记录保留。</p>
          <button type="button" className="provider-text-button" disabled={!!busy} onClick={()=>setLegacyDeleteId('')}>取消</button>
          <button type="button" className="provider-text-button danger-text" disabled={!!busy}
            onClick={()=>void run('delete-legacy',()=>api.deleteGatewayToken(token.id),'旧凭据已删除').then(result=>{if(result)setLegacyDeleteId('');})}>确认删除旧凭据</button>
        </div>}
      </div>)}
    </details>}
  </section>;
}
