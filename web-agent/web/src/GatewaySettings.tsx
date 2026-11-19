import {useCallback,useEffect,useRef,useState} from 'react';
import type {GatewayCommand,GatewayConnection,GatewayConnections,GatewayInstructionTask,GatewayMessage,GatewayMessagePage,GatewayRouting,LakeEventSourceUpdate,SessionSnapshot} from '../../shared/contracts';
import {api,readableError} from './api';
import {AppSelect} from './AppSelect';
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
  return <section className="gateway-messages" aria-labelledby="gateway-messages-title"><div className="gateway-section-heading"><h4 id="gateway-messages-title">消息与任务</h4><div className="gateway-history-actions">{(messages.length>1||nextCursor||expanded)&&<button className="provider-text-button" type="button" aria-expanded={expanded} aria-controls="gateway-message-history" onClick={toggleHistory}>{expanded?'收起历史消息':'查看全部消息'}<Glyph name={expanded?'up':'next'} size={13}/></button>}<button className="provider-text-button" type="button" disabled={loading} onClick={()=>void load()}><Glyph name="refresh" size={13}/>刷新</button></div></div>
    {loading&&<p className="settings-note" role="status">正在读取消息与任务…</p>}
    {error&&<div className="gateway-message-error" role="alert"><p className="form-error">{error}</p><button type="button" className="provider-text-button" onClick={()=>void load()}>重试</button></div>}
    {!loading&&!error&&!messages.length&&<div className="gateway-empty"><Glyph name="chat" size={24}/><h4>还没有收到消息</h4><p>复制接入配置到外部客户端。收到消息后，这里会展示 Pilot 的回复及关联任务。</p></div>}
    <GatewayMessageList messages={messages} expanded={expanded} connectionName={connection.name} onTask={onTask} disabled={disabled}/>
    {expanded&&nextCursor&&<button className="provider-text-button gateway-load-more" type="button" disabled={loading} onClick={()=>{if(flight.current)return;pages.current++;setLoading(true);void load();}}>加载更多消息<Glyph name="down" size={13}/></button>}
  </section>;
}

export function GatewaySettings({onBusyChange,projectId,onTask}:{onBusyChange:(value:boolean)=>void;projectId?:string;onTask?:(target:GatewayTaskTarget)=>Promise<void>}){
  const [catalog,setCatalog]=useState<GatewayConnections>(),[selected,setSelected]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[error,setError]=useState(''),[feedback,setFeedback]=useState('');
  const [creating,setCreating]=useState(false),[name,setName]=useState(''),[project,setProject]=useState(projectId??''),[route,setRoute]=useState('pilot');
  const [credential,setCredential]=useState<{sourceId:string;token:string}>();
  const [legacyDeleteId,setLegacyDeleteId]=useState('');
  const [rename,setRename]=useState(false),[newName,setNewName]=useState(''),[deleteConfirm,setDeleteConfirm]=useState(false),[configVisible,setConfigVisible]=useState(false);
  const mounted=useRef(true),flight=useRef(false),cancelLoad=useRef<AbortController|undefined>(undefined),nameInput=useRef<HTMLInputElement>(null);
  const selectedRef=useRef(selected);selectedRef.current=selected;
  const connection=catalog?.connections.find(entry=>entry.id===selected);
  const source=catalog?.eventSources?.find(entry=>entry.id===selected);
  const entries=[...(catalog?.connections??[]),...(catalog?.eventSources??[])];
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
  useEffect(()=>{setDeleteConfirm(false);setRename(false);setConfigVisible(false);setFeedback('');setError('');},[selected]);
  useEffect(()=>{if(creating||rename)nameInput.current?.focus();},[creating,rename]);
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
  const copy=async(value:string)=>{try{await navigator.clipboard.writeText(value);if(mounted.current)setFeedback('接入配置已复制');}catch{if(mounted.current){setConfigVisible(true);setError('无法写入剪贴板，请从下方复制配置。');}}};
  const inspect=async(target:GatewayTaskTarget)=>{if(!onTask||flight.current)return;flight.current=true;setBusy('task');setError('');try{await onTask(target);}catch(cause){if(mounted.current)setError(readableError(cause));}finally{flight.current=false;if(mounted.current)setBusy('');}};
  const available=catalog?.specialists.filter(role=>role.projectId===(creating?project:connection?.projectId))??[];
  const selectRouting=(value:string,change:(value:string)=>void,label='处理方式')=><label className="field-label">{label}<AppSelect value={value} disabled={!!busy} onChange={event=>change(event.target.value)}><option value="pilot">Pilot 自动路由</option>{available.map(role=><option key={role.roleId} value={role.roleId}>固定专员：{role.name}</option>)}{value!=='pilot'&&!available.some(role=>role.roleId===value)&&<option value={value}>原专员不可用</option>}</AppSelect><small>根据消息内容回复、追问或分派专员。</small></label>;
  return <section id="channels-settings-panel" role="tabpanel" aria-labelledby="channels-settings-tab" className="gateway-settings" onKeyDown={event=>{if(event.key!=='Escape'||busy)return;if(creating||rename||deleteConfirm||legacyDeleteId){event.preventDefault();event.stopPropagation();setCreating(false);setRename(false);setDeleteConfirm(false);setLegacyDeleteId('');event.currentTarget.querySelector<HTMLElement>('.gateway-rail-heading button')?.focus();}}}>
    <aside className="gateway-rail" aria-label="接入连接"><div className="gateway-rail-heading"><h3>我的连接 <small>{entries.length}</small></h3><button type="button" className="button primary" disabled={loading||!!busy} onClick={()=>{setCreating(true);setRename(false);setName('');setRoute('pilot');setCredential(undefined);setError('');setFeedback('');}}><Glyph name="plus" size={14}/>添加连接</button></div>
      {loading&&<p className="settings-note" role="status">正在读取接入渠道…</p>}
      <ul className="gateway-connections">
        {entries.map(entry=>{
          const grafana='kind' in entry;
          const description=grafana?'告警':'消息';
          return <li key={entry.id}>
            <button type="button" className={`gateway-connection ${!creating&&entry.id===selected?'selected':''}`}
              disabled={!!busy} aria-pressed={!creating&&entry.id===selected} onClick={()=>{
                if(entry.id!==selected)setCredential(undefined);
                setSelected(entry.id);
                setCreating(false);
              }}>
              <span className="gateway-connection-icon"><Glyph name={grafana?'grafana':'plug'} size={20}/></span>
              <span className="gateway-connection-copy">
                <strong>{entry.name}</strong>
                <small>{grafana?'Grafana':'MCP'} · {catalog?.projects.find(item=>item.id===entry.projectId)?.name??'原项目不可用'}</small>
                <time dateTime={entry.lastReceivedAt}>{entry.lastReceivedAt?`${time(entry.lastReceivedAt)} 收到${description}`:`暂无${description}`}</time>
              </span>
              <span className={`gateway-enabled ${entry.enabled?'on':''}`}>{entry.enabled?'已启用':'已停用'}</span>
            </button>
          </li>;
        })}
      </ul>
      {!loading&&!entries.length&&<p className="settings-note">添加连接，让外部客户端接入 Lake。</p>}
      {!!catalog?.legacyTokens.length&&<details className="gateway-legacy"><summary>兼容接入 · {catalog.legacyTokens.length}</summary><p>原单专员配置继续使用原权限范围。</p>{catalog.legacyTokens.map(token=><div key={token.id}><strong>{token.name}</strong><small>{token.roles?.length?`限定 ${token.roles.length} 位专员`:'原全部专员范围'}</small><button className="provider-text-button" type="button" onClick={()=>void copy(gatewayCommandSnippet(catalog.command,token.id,token.roles?.length===1?token.roles[0]:undefined))}>复制旧命令<Glyph name="copy" size={13}/></button><button type="button" className="provider-text-button danger-text" disabled={!!busy} onClick={()=>setLegacyDeleteId(token.id)}>删除旧凭据</button>{legacyDeleteId===token.id&&<div className="gateway-legacy-confirm" role="group" aria-label={`确认删除旧凭据 ${token.name}`}><p>删除后原连接立即失效，任务记录保留。</p><button type="button" className="provider-text-button" disabled={!!busy} onClick={()=>setLegacyDeleteId('')}>取消</button><button type="button" className="provider-text-button danger-text" disabled={!!busy} onClick={()=>void run('delete-legacy',()=>api.deleteGatewayToken(token.id),'旧凭据已删除').then(result=>{if(result)setLegacyDeleteId('');})}>确认删除旧凭据</button></div>}</div>)}</details>}
    </aside>
    <div className="gateway-detail">
      {creating?<form className="gateway-create" onSubmit={event=>{event.preventDefault();void create();}}>
        <h3>添加连接</h3>
        <label className="field-label">连接名称
          <input ref={nameInput} value={name} onChange={event=>setName(event.target.value)} maxLength={120} autoComplete="off"
            placeholder="例如：我的 Codex" disabled={!!busy}/>
        </label>
        <label className="field-label">所属项目
          <AppSelect label="所属项目" value={project} disabled={!!busy} onChange={event=>{setProject(event.target.value);setRoute('pilot');}}>
            {catalog?.projects.map(entry=><option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </AppSelect>
        </label>
        {selectRouting(route,setRoute)}
        {!catalog?.projects.length&&<p className="settings-note">请先在工作区创建项目。</p>}
        <div className="gateway-form-actions">
          <button className="button secondary" type="button" disabled={!!busy} onClick={()=>setCreating(false)}>取消</button>
          <button className="button primary" type="submit" disabled={!!busy||!name.trim()||!project}>{busy==='create'?'创建中…':'创建连接'}</button>
        </div>
      </form>:source&&catalog?<GrafanaEventSource key={source.id} source={source}
        projectName={catalog.projects.find(item=>item.id===source.projectId)?.name??'原项目不可用'}
        token={credential?.sourceId===source.id?credential.token:undefined}
        disabled={!!busy} onUpdate={value=>void updateSource(value)} onDismissToken={()=>setCredential(undefined)}
        onReceipt={at=>setCatalog(current=>{
          if(!current||current.eventSources?.find(entry=>entry.id===source.id)?.lastReceivedAt===at)return current;
          return {...current,eventSources:current.eventSources?.map(entry=>entry.id===source.id?{...entry,lastReceivedAt:at}:entry)};
        })}/>:connection&&catalog?<>
        <header className="gateway-detail-header"><div className="gateway-detail-title"><span className="gateway-connection-icon"><Glyph name="plug" size={20}/></span><h3>{connection.name}</h3><span className="gateway-protocol">MCP</span></div><div className="gateway-detail-actions"><button type="button" role="switch" aria-checked={connection.enabled} aria-label={`启用连接 ${connection.name}`} className={`provider-switch ${connection.enabled?'on':''}`} disabled={!!busy} onClick={()=>void update({enabled:!connection.enabled})}><span/></button><span>{connection.enabled?'已启用':'已停用'}</span><button className="button secondary" type="button" disabled={!!busy} onClick={()=>void copy(gatewayClientConfig(catalog.command,connection))}><Glyph name="copy" size={14}/>复制接入配置</button></div></header>
        <p className="settings-note gateway-detail-note">接收这个客户端的消息，并将回复返回原会话。</p>
        <div className="gateway-fields"><label className="field-label">所属项目<AppSelect value={connection.projectId} disabled title="连接的项目固定；如需更换项目，请添加连接">{catalog.projects.some(item=>item.id===connection.projectId)?catalog.projects.map(entry=><option key={entry.id} value={entry.id}>{entry.name}</option>):<option value={connection.projectId}>原项目不可用</option>}</AppSelect><small>更换项目请添加连接。</small></label>{selectRouting(connection.routing.mode==='pilot'?'pilot':connection.routing.roleId,value=>void update({routing:routing(value)}))}</div>
        <GatewayMessages key={connection.id} connection={connection} onTask={target=>void inspect(target)} disabled={!!busy} onReceipt={(id,at)=>setCatalog(current=>current?{...current,connections:current.connections.map(entry=>entry.id===id&&(!entry.lastReceivedAt||entry.lastReceivedAt<at)?{...entry,lastReceivedAt:at}:entry)}:current)}/>
        <footer className="gateway-connection-footer"><small>{connection.lastReceivedAt?`最近收件：${time(connection.lastReceivedAt)}`:'尚未收到客户端消息'}</small><button className="button secondary" type="button" disabled={!!busy||!connection.enabled} onClick={()=>void run('test',()=>api.testGatewayConnection(connection.id),'').then(value=>{if(value&&mounted.current&&selectedRef.current===connection.id)setFeedback((value as {message:string}).message);})}><Glyph name={busy==='test'?'loader':'plug'} size={14}/>测试接入</button></footer>
        <details className="gateway-manage" open={configVisible||rename||deleteConfirm||undefined} onToggle={event=>{if(!(event.currentTarget as HTMLDetailsElement).open){setConfigVisible(false);setRename(false);setDeleteConfirm(false);}}}><summary>连接配置与管理</summary><div className="gateway-manage-actions"><button className="provider-text-button" type="button" disabled={!!busy} onClick={()=>{setNewName(connection.name);setRename(true);setDeleteConfirm(false);}}>重命名</button><button className="provider-text-button" type="button" disabled={!!busy} onClick={()=>setConfigVisible(value=>!value)}>查看接入配置</button><button className="provider-text-button danger-text" type="button" disabled={!!busy} onClick={()=>{setDeleteConfirm(true);setRename(false);}}>删除连接</button></div>{rename&&<form onSubmit={event=>{event.preventDefault();void update({name:newName.trim()})?.then(result=>{if(result)setRename(false);});}}><label className="field-label">连接名称<input ref={nameInput} value={newName} onChange={event=>setNewName(event.target.value)} maxLength={120} disabled={!!busy}/></label><button className="button secondary" type="button" onClick={()=>setRename(false)}>取消</button><button className="button primary" type="submit" disabled={!!busy||!newName.trim()}>保存名称</button></form>}{deleteConfirm&&<div className="gateway-delete-confirm" role="group" aria-label="确认删除连接"><p>删除「{connection.name}」后将立即拒绝新接入，原消息及任务记录保留。</p><button type="button" autoFocus className="button secondary" disabled={!!busy} onClick={()=>setDeleteConfirm(false)}>取消</button><button type="button" className="button secondary danger-text" disabled={!!busy} onClick={()=>void run('delete',()=>api.deleteGatewayConnection(connection.id),'连接已删除，原任务记录保留')}>确认删除</button></div>}{configVisible&&<><p className="settings-note">将此配置加入外部客户端的 MCP 设置。启动 Lake 后可使用；凭据保存在本机私有目录。</p><pre className="gateway-config" tabIndex={0}>{gatewayClientConfig(catalog.command,connection)}</pre></>}</details>
      </>:!loading&&<div className="gateway-empty"><Glyph name="plug" size={28}/><h3>接入渠道</h3><p>选择连接，查看收到的消息。</p></div>}
      {error&&<div className="gateway-feedback" role="alert"><p className="form-error">{error}</p>{!catalog&&<button type="button" className="button secondary" onClick={()=>{setLoading(true);void load().catch(cause=>setError(readableError(cause)));}}>重新读取</button>}</div>}<p className="gateway-feedback settings-note" role="status">{busy?'正在处理…':feedback}</p>
    </div>
  </section>;
}
