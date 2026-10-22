import {useEffect,useRef,useState} from 'react';
import type {MCPServerConfig,MCPToolCatalog} from '../../shared/contracts';
import {api,readableError} from './api';
import {AppSelect} from './AppSelect';
import {Glyph} from './Icons';
import {DisclosureSummary} from './DisclosureSummary';
import {formatMCPArgs,mcpJSON,mcpProtocols,mcpSecretMap,parseMCPArgs,parseMCPJSON,validateMCPInput,type MCPInput} from './mcpConfig';
import './extensionSettings.css';
const fresh=():MCPServerConfig=>({id:'',name:'',transport:'stdio',enabled:true,url:'',command:'',args:[],headersConfigured:false,envConfigured:false,timeoutMs:30000,protocolVersion:''});
export function MCPSettings({onBusyChange}:{onBusyChange:(busy:boolean)=>void}){
 const detail=useRef<HTMLDivElement>(null),file=useRef<HTMLInputElement>(null);
 const [servers,setServers]=useState<MCPServerConfig[]>([]),[draft,setDraft]=useState<MCPServerConfig|null>(null);
 const [mode,setMode]=useState<'form'|'json'>('form'),[source,setSource]=useState(''),[args,setArgs]=useState(''),[headers,setHeaders]=useState(''),[env,setEnv]=useState('');
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[dirty,setDirty]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[tools,setTools]=useState<MCPToolCatalog|null>(null),[deleteId,setDeleteId]=useState('');
 useEffect(()=>{let active=true;void api.mcpServers().then(data=>{if(active)setServers(data.servers);}).catch(err=>{if(active)setError(readableError(err));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
 function edit(next:MCPServerConfig){setDraft({...next,timeoutMs:next.timeoutMs||30000,protocolVersion:next.protocolVersion||''});setArgs(formatMCPArgs(next.args));setHeaders('');setEnv('');setSource('');setMode('form');setDirty(!next.id);setError('');setNotice('');setTools(null);setDeleteId('');detail.current?.scrollTo({top:0});}
 function cancel(){setDraft(null);setSource('');setHeaders('');setEnv('');setArgs('');setDirty(false);setError('');setNotice('');detail.current?.scrollTo({top:0});}
 function changed(){setDirty(true);setError('');setNotice('');}
 function update(patch:Partial<MCPServerConfig>){setDraft(current=>current?{...current,...patch}:null);changed();}
 function formValue():MCPInput{
  if(!draft)throw new Error('请先选择服务');
  return {name:draft.name,transport:draft.transport,enabled:draft.enabled,url:draft.url,command:draft.command,args:parseMCPArgs(args),timeoutMs:draft.timeoutMs??30000,protocolVersion:draft.protocolVersion??'',...mapFields()};
 }
 function mapFields(){const nextHeaders=mcpSecretMap(headers,'请求头'),nextEnv=mcpSecretMap(env,'环境变量');return {...(nextHeaders!==undefined?{headers:nextHeaders}:{}),...(nextEnv!==undefined?{env:nextEnv}:{})};}
 function switchMode(next:'form'|'json'){
  if(next===mode)return true;
  try{
   if(next==='json')setSource(mcpJSON([formValue()]));
   else{const rows=parseMCPJSON(source);if(rows.length!==1)throw new Error('包含多个服务，请在 JSON 模式下保存导入');const row=rows[0]!;setDraft(current=>({...fresh(),...current,...row}));setArgs(formatMCPArgs(row.args));setHeaders(row.headers===undefined?'':JSON.stringify(row.headers));setEnv(row.env===undefined?'':JSON.stringify(row.env));}
   setMode(next);setError('');return true;
  }catch(err){setError(readableError(err));return false;}
 }
 async function run(kind:string,task:()=>Promise<void>){setBusy(kind);onBusyChange(true);setError('');setNotice('');try{await task();}catch(err){setError(readableError(err));detail.current?.scrollTo({top:0});}finally{setBusy('');onBusyChange(false);}}
 async function save(){
  if(!draft)return;
  const rows=mode==='json'?parseMCPJSON(source):[formValue()];rows.forEach(validateMCPInput);
  if(draft.id){
   if(rows.length!==1)throw new Error('编辑已有服务时只能保存一个配置，请新建服务进行批量导入');
   const saved=await api.saveMCP({...rows[0],id:draft.id});setServers(current=>current.map(row=>row.id===saved.id?saved:row));cancel();setNotice('MCP 配置已保存。');
  }else{
   const imported=await api.importMCP(JSON.parse(mcpJSON(rows)));setServers(current=>[...current,...imported.servers]);cancel();setNotice(`已导入 ${imported.servers.length} 个 MCP 服务。`);
  }
 }
 async function importFile(selected:File){
  if(selected.size>100000)throw new Error('JSON 配置不能超过 100 KB');
  let text:string;try{text=await selected.text();}catch{throw new Error('无法读取 JSON 文件，请重新选择');}
  setSource(text.replace(/^\uFEFF/,''));setMode('json');changed();
 }
 let count=0;if(mode==='json')try{count=parseMCPJSON(source).length;}catch{ /* Save reports validation errors without echoing pasted data. */ }
 return <section id="mcp-settings-panel" role="tabpanel" aria-labelledby="mcp-settings-tab" className="extension-settings mcp-settings"><div className="mcp-content" ref={detail}>
  {error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="provider-success" role="status">{notice}</p>}
  {draft?<>
   <div className="mcp-editor-heading"><div><h3>{draft.id?'编辑 MCP 服务器':'新建 MCP 服务器'}</h3><p>填写 MCP 配置，保存后返回列表。</p></div><div className="mcp-mode-tabs" role="tablist" aria-label="MCP 配置方式">{(['form','json'] as const).map(value=><button type="button" key={value} role="tab" id={`mcp-mode-${value}`} aria-controls="mcp-config-editor" aria-selected={mode===value} tabIndex={mode===value?0:-1} disabled={!!busy} onClick={()=>switchMode(value)} onKeyDown={event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const next=value==='form'?'json':'form';if(switchMode(next))event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#mcp-mode-${next}`)?.focus();}}}>{value==='form'?'表单':'JSON'}</button>)}</div></div>
   <div id="mcp-config-editor" role="tabpanel" aria-labelledby={`mcp-mode-${mode}`} className="mcp-editor-card">
    <div className="mcp-scope"><span>作用域</span><span className="mcp-scope-value"><Glyph name="local" size={16}/>用户 · 本机</span></div>
    <fieldset disabled={!!busy} className="mcp-form-fields">
     {mode==='json'?<><label className="field-label">完整配置<textarea className="extension-code mcp-json-input" rows={12} spellCheck={false} autoComplete="off" value={source} onChange={event=>{setSource(event.target.value);changed();}}/></label><p className="settings-note">支持直接粘贴 {'{"server-name": {...}}'} 或 {'{"mcpServers": {"server-name": {...}}}'}，也可一次导入多个服务。</p><div className="mcp-json-file"><input className="visually-hidden" ref={file} type="file" accept=".json,application/json" aria-label="选择 MCP JSON 文件" onChange={event=>{const selected=event.target.files?.[0];if(selected)void run('file',()=>importFile(selected));event.target.value='';}}/><button type="button" className="provider-text-button" onClick={()=>file.current?.click()}><Glyph name="document" size={14}/>导入 JSON 文件</button>{count>0&&<span className="settings-note">{count} 个服务</span>}</div>{draft.id&&(draft.headersConfigured||draft.envConfigured)&&<p className="settings-note">已保存的认证信息不会回填；省略 headers / env 保留原值，使用 {'{}'} 清空。</p>}</>:<>
      <label className="field-label mcp-narrow-field">名称<input maxLength={120} placeholder="my-mcp-server" value={draft.name} onChange={event=>update({name:event.target.value})}/></label>
      <label className="field-label mcp-narrow-field">类型<AppSelect label="MCP 连接类型" value={draft.transport} onChange={event=>update({transport:event.target.value as MCPServerConfig['transport']})}><option value="stdio">stdio（本地命令）</option><option value="http">Streamable HTTP</option><option value="sse">SSE（兼容旧服务）</option></AppSelect></label>
      <label className="field-label mcp-narrow-field">超时时间 MS<input type="number" min={1000} max={300000} step={1000} value={draft.timeoutMs??30000} onChange={event=>update({timeoutMs:Number(event.target.value)})}/></label>
      <label className="field-label mcp-narrow-field">协议版本<AppSelect label="MCP 协议版本" value={draft.protocolVersion||''} onChange={event=>update({protocolVersion:event.target.value})}><option value="">自动（推荐）</option>{mcpProtocols.map(version=><option key={version} value={version}>{version}</option>)}</AppSelect></label>
      {draft.transport==='stdio'?<><label className="field-label">命令<input value={draft.command} placeholder="npx" spellCheck={false} onChange={event=>update({command:event.target.value})}/></label><label className="field-label">参数（空格分隔）<input value={args} placeholder="-y @modelcontextprotocol/server-memory" spellCheck={false} onChange={event=>{setArgs(event.target.value);changed();}}/></label><p className="settings-note">含空格的参数请加引号，也可粘贴 JSON 字符串数组。</p><details className="mcp-extra-fields"><DisclosureSummary>环境变量（可选）</DisclosureSummary><label className="field-label">环境变量 · JSON 对象<input type="password" autoComplete="new-password" value={env} placeholder={draft.envConfigured?'已保存，留空保留；输入 {} 清空':'{"API_TOKEN":"…"}'} onChange={event=>{setEnv(event.target.value);changed();}}/></label></details></>:<><label className="field-label">服务地址<input value={draft.url} placeholder="https://example.com/mcp" spellCheck={false} onChange={event=>update({url:event.target.value})}/></label><details className="mcp-extra-fields"><DisclosureSummary>认证与请求头（可选）</DisclosureSummary><label className="field-label">请求头 · JSON 对象<input type="password" autoComplete="new-password" value={headers} placeholder={draft.headersConfigured?'已保存，留空保留；输入 {} 清空':'{"Authorization":"Bearer …"}'} onChange={event=>{setHeaders(event.target.value);changed();}}/></label></details></>}
      <label className="extension-check"><input type="checkbox" checked={draft.enabled} onChange={event=>update({enabled:event.target.checked})}/>启用此服务</label>
     </>}
    </fieldset>
    <div className="mcp-editor-actions"><button type="button" className="button primary" disabled={!!busy||!dirty||(mode==='form'?!draft.name.trim():!source.trim())} onClick={()=>void run('save',save)}>{busy==='save'?'保存中…':count>1?`导入 ${count} 个服务`:'保存'}</button><button type="button" className="provider-text-button" disabled={!!busy} onClick={cancel}>取消</button></div>
   </div>
  </>:<>
   <div className="mcp-editor-heading"><div><h3>MCP 服务器</h3><p>接入本机命令或远程工具服务。</p></div><div className="mcp-list-actions"><button type="button" className="icon-button" aria-label="刷新 MCP 服务" disabled={!!busy||loading} onClick={()=>void run('refresh',async()=>{setServers((await api.mcpServers()).servers);})}><Glyph name="refresh" size={15}/></button><button type="button" className="button primary" disabled={!!busy||loading} onClick={()=>edit(fresh())}><Glyph name="plus" size={14}/>新建 MCP 服务器</button></div></div>
   {loading?<p className="settings-note">正在加载…</p>:servers.length?<div className="mcp-server-list">{servers.map(server=><div key={server.id} className="mcp-server-row"><Glyph name={server.transport==='stdio'?'terminal':'plug'} size={20}/><div className="mcp-server-copy"><strong>{server.name}</strong><small>{server.transport==='stdio'?'stdio · 本地命令':server.transport==='sse'?'SSE':'Streamable HTTP'} · 用户 · 本机</small></div><label className="extension-check"><input type="checkbox" aria-label={`启用 ${server.name}`} checked={server.enabled} disabled={!!busy} onChange={event=>{const enabled=event.target.checked;void run('toggle',async()=>{const saved=await api.saveMCP({...server,enabled});setServers(current=>current.map(row=>row.id===saved.id?saved:row));});}}/>启用</label><div className="mcp-row-actions"><button type="button" className="provider-text-button" disabled={!!busy} onClick={()=>edit(server)}>编辑<span className="visually-hidden"> {server.name}</span></button><button type="button" className="provider-text-button" disabled={!!busy} onClick={()=>void run('test',async()=>{setTools(await api.testMCP(server.id));})}>{busy==='test'?'连接中…':'测试连接'}<span className="visually-hidden"> {server.name}</span></button><button type="button" className="icon-button danger-text" aria-label={`移除 ${server.name}`} disabled={!!busy} onClick={()=>setDeleteId(server.id)}><Glyph name="trash" size={15}/></button></div>{deleteId===server.id&&<div className="mcp-delete-confirm"><span>移除「{server.name}」的 MCP 配置？</span><button type="button" className="provider-text-button" disabled={!!busy} onClick={()=>setDeleteId('')}>取消</button><button type="button" className="provider-text-button danger-text" disabled={!!busy} onClick={()=>void run('delete',async()=>{await api.deleteMCP(server.id);setServers(current=>current.filter(row=>row.id!==server.id));setDeleteId('');setTools(null);setNotice('已移除配置。');})}>确认移除</button></div>}</div>)}</div>:<div className="extension-empty"><Glyph name="plug" size={36}/><h3>接入 MCP 工具</h3><p>通过表单或 JSON 配置添加服务。</p></div>}
   {tools&&<section className="extension-tools" aria-label="MCP 工具列表"><h4><Glyph name="check" size={15}/>{tools.serverName} · 连接成功 · {tools.count} 个工具</h4>{tools.tools.map(tool=><details key={tool.name}><DisclosureSummary>{tool.name}</DisclosureSummary><p>{tool.description||'无说明'}</p><pre>{JSON.stringify(tool.inputSchema,null,2)}</pre></details>)}</section>}
  </>}
 </div></section>;
}
