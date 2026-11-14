import {useEffect,useRef,useState} from 'react';
import type {GatewaySpecialistRef,GatewayTokenView} from '../../shared/contracts';
import {api,readableError} from './api';
import {AppSelect} from './AppSelect';
import {Glyph} from './Icons';

type Command = {program:string;script?:string;home:string};
export function GatewaySettings({onBusyChange}:{onBusyChange:(value:boolean)=>void}){
  const [tokens,setTokens]=useState<GatewayTokenView[]>([]),[specialists,setSpecialists]=useState<GatewaySpecialistRef[]>([]);
  const [command,setCommand]=useState<Command|undefined>();
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [name,setName]=useState(''),[role,setRole]=useState('');
  const [created,setCreated]=useState<{name:string;token:string;snippet:string}|undefined>(),[copied,setCopied]=useState('');
  const mounted=useRef(true),flight=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{onBusyChange(!!busy);return()=>onBusyChange(false);},[busy,onBusyChange]);
  async function load(signal?:AbortSignal){
    const [list,roles]=await Promise.all([api.gatewayTokens(),api.gatewaySpecialists().catch(()=>({specialists:[] as GatewaySpecialistRef[]}))]);
    if(signal?.aborted||!mounted.current)return;
    setTokens(list.tokens);setCommand(list.command);setSpecialists(roles.specialists);
  }
  useEffect(()=>{const cancel=new AbortController();setLoading(true);setError('');
    void load(cancel.signal).catch(cause=>{if(!cancel.signal.aborted)setError(readableError(cause));}).finally(()=>{if(!cancel.signal.aborted)setLoading(false);});
    return()=>cancel.abort();},[]);
  async function run<T>(key:string,work:()=>Promise<T>,success:string):Promise<T|undefined>{
    if(flight.current)return;flight.current=true;setBusy(key);setError('');setMessage('');
    try{const value=await work();await load();if(mounted.current)setMessage(success);return value;}
    catch(cause){try{await load();}catch{}if(mounted.current)setError(readableError(cause));}
    finally{flight.current=false;if(mounted.current)setBusy('');}
  }
  const snippet=(tokenId:string,roleId?:string)=>[command?.program??'lake',command?.script,'--mcp-specialist','--home',command?.home??'~/.lake',roleId?['--role',roleId]:[],'--token-id',tokenId].flat().filter(Boolean).map(part=>/\s/.test(String(part))?`"${part}"`:String(part)).join(' ');
  const create=async()=>{
    const value=await run('create',()=>api.createGatewayToken({name:name.trim(),...(role?{roles:[role]}:{})}),'网关凭据已创建，令牌只显示这一次');
    if(value){setName('');setRole('');setCreated({name:value.name,token:value.token,snippet:snippet(value.id,role||undefined)});}
  };
  const remove=(token:GatewayTokenView)=>void run(token.id,()=>api.deleteGatewayToken(token.id),'网关凭据已删除，现有连接立即失效');
  const copy=async(text:string,key:string)=>{try{await navigator.clipboard.writeText(text);setCopied(key);setTimeout(()=>setCopied(''),1600);}catch{}};
  return <article className="external-agent-panel gateway-settings" aria-labelledby="gateway-settings-title">
    <header><span className="external-agent-mark"><Glyph name="plug" size={20}/></span><div><h3 id="gateway-settings-title">外部研发 Agent 接入（MCP）</h3><small>每个专员一个 stdio MCP 入口</small></div></header>
    <p className="settings-note">研发人员在自家 Agent（Claude Code、Codex 等）的 MCP 配置中加入下方命令，即可给专员发指令、收取回应。指令等同专员频道的本人输入：Pilot 路由、资源权限与计划/审批确认全部照旧在 Lake 界面完成；令牌只能发指令和读状态，可随时删除。</p>
    {loading&&<p role="status">正在读取网关凭据…</p>}
    {!loading&&<div className="gateway-create">
      <label className="field-label">凭据名称<input spellCheck={false} autoComplete="off" placeholder="例如：研发 Claude Code" value={name} maxLength={120} onChange={event=>setName(event.target.value)}/></label>
      <label className="field-label gateway-role-field">允许的专员<AppSelect value={role} disabled={!!busy} onChange={event=>setRole(event.target.value)}>{<option value="">全部专员</option>}{specialists.map(entry=><option key={entry.roleId} value={entry.roleId}>{entry.name}{entry.roleKey&&entry.roleKey!==entry.name?` · ${entry.roleKey}`:''}</option>)}</AppSelect></label>
      <button type="button" className="button primary" disabled={!!busy||!name.trim()} onClick={()=>void create()}><Glyph name={busy==='create'?'loader':'plus'} size={14}/>{busy==='create'?'创建中…':'创建凭据'}</button>
    </div>}
    {created&&<div className="gateway-created" role="status">
      <p><strong>{created.name}</strong> 的令牌（只显示这一次，请立即保存）：<code>{created.token}</code></p>
      <div className="gateway-snippet"><code>{created.snippet}</code><button type="button" className="provider-text-button" onClick={()=>void copy(created.snippet,'created')}><Glyph name={copied==='created'?'check':'copy'} size={13}/>{copied==='created'?'已复制':'复制 MCP 配置命令'}</button></div>
    </div>}
    {!loading&&tokens.length>0&&<ul className="gateway-tokens">{tokens.map(token=><li key={token.id} className="gateway-token-row">
      <div className="gateway-token-meta"><strong>{token.name}</strong><span>{token.roles?.length?`限定专员：${specialists.find(entry=>entry.roleId===token.roles![0])?.name??token.roles[0]}`:'全部专员'}</span><time dateTime={token.createdAt}>{new Date(token.createdAt).toLocaleString('zh-CN',{hour12:false})}</time></div>
      <div className="gateway-snippet"><code>{snippet(token.id,token.roles?.[0])}</code><button type="button" className="provider-text-button" onClick={()=>void copy(snippet(token.id,token.roles?.[0]),token.id)}><Glyph name={copied===token.id?'check':'copy'} size={13}/>{copied===token.id?'已复制':'复制'}</button></div>
      <button type="button" className="provider-text-button gateway-token-delete" disabled={!!busy} onClick={()=>remove(token)}><Glyph name="trash" size={13}/>删除</button>
    </li>)}</ul>}
    {!loading&&!tokens.length&&!created&&<p className="settings-note" role="status">还没有网关凭据。创建一条并复制命令到研发 Agent 的 MCP 配置即可接入。</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}<p className="settings-note" role="status">{busy&&!loading?'正在处理…':message}</p>
  </article>;
}
