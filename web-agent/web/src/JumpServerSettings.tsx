import {useEffect, useRef, useState, type ReactNode} from "react";
import type {JumpServerBinding, JumpServerLogin, JumpServerPreview, Project, Resource} from "../../shared/contracts";
import {api, readableError} from "./api";
import {AppSelect} from "./AppSelect";
import {Glyph} from "./Icons";
import "./jumpServer.css";

const defaultOrganizationId = "00000000-0000-0000-0000-000000000002";
type BindingOperation = "verify" | "bind" | "sync" | "certificate" | "endpoint" | "remove";

function Dialog({title, children, close}: {title:string; children:ReactNode; close:()=>void}) {
  const ref=useRef<HTMLElement>(null);
  useEffect(()=>{const previous=document.activeElement;ref.current?.focus();return ()=>{if(previous instanceof HTMLElement && previous.isConnected)previous.focus();};},[]);
  return <div className="modal-scrim"><section ref={ref} tabIndex={-1} className="modal jumpserver-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={e=>{
    if(e.key==="Escape"&&!e.defaultPrevented){e.stopPropagation();close();}
    if(e.key==="Tab"){
      const elements=Array.from(ref.current!.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary")).filter(el=>el.getClientRects().length>0);
      if(e.shiftKey && document.activeElement===elements[0]){e.preventDefault();elements.at(-1)?.focus();}
      else if(!e.shiftKey && document.activeElement===elements.at(-1)){e.preventDefault();elements[0]?.focus();}
    }
  }}>
    <header><h2>{title}</h2><button type="button" className="icon-button" aria-label="关闭" onClick={close}><Glyph name="close" size={16}/></button></header>
    {children}
  </section></div>;
}

export function JumpServerSettings({project,onClose,refresh}: {project:Project;onClose:()=>void;refresh:()=>Promise<unknown>}) {
  const [binding,setBinding]=useState<JumpServerBinding|null>(null), [loading,setLoading]=useState(true);
  const [edit,setEdit]=useState(false), [confirmRemove,setConfirmRemove]=useState(false);
  const [editEndpoint,setEditEndpoint]=useState(false);
  const [login,setLogin]=useState<JumpServerLogin>({origin:"",orgId:"",authMethod:"accessKey",secret:""});
  const [preview,setPreview]=useState<JumpServerPreview|null>(null),[node,setNode]=useState("");
  const [host,setHost]=useState(""),[port,setPort]=useState("2222");
  const [operation,setOperation]=useState<BindingOperation|null>(null);
  const [error,setError]=useState(""), [feedback,setFeedback]=useState("");
  const busy=operation!==null;
  const syncing=(operation==="bind" || operation==="sync") && !feedback;
  const certificateFile = useRef<HTMLInputElement>(null);
  const mounted=useRef(true);
  useEffect(()=>{
    mounted.current=true;
    void api.jumpServerBinding(project.id).then(({binding:b})=>{
      if(!mounted.current)return;
      setBinding(b);
      if(b) {setLogin(v=>({...v,origin:b.origin,orgId:b.orgId,authMethod:b.authMethod}));setHost(b.kokoHost);setPort(String(b.kokoPort));setNode(b.nodeId??"");}
    }).catch(e=>mounted.current&&setError(readableError(e))).finally(()=>mounted.current&&setLoading(false));
    return ()=>{mounted.current=false;};
  },[project.id]);
  const change=(value:Partial<JumpServerLogin>)=>{setLogin(v=>({...v,...value}));setPreview(null);setError("");};
  const run = async (kind: BindingOperation, action: () => Promise<void>) => {
    setOperation(kind);
    setError("");
    setFeedback("");
    try {
      await action();
    } catch (error) {
      if (mounted.current) setError(readableError(error));
    } finally {
      if (mounted.current) setOperation(null);
    }
  };
  const completeSync = async (updated: JumpServerBinding, message: string) => {
    setBinding(updated);
    setFeedback(`${message}，共 ${updated.assetCount} 个授权资产`);
    try {
      await refresh();
    } catch (error) {
      throw new Error(`资源列表刷新失败。 ${readableError(error)}`);
    }
  };
  const syncNow = async () => {
    let updated: JumpServerBinding;
    try {
      updated = await api.syncJumpServer(project.id);
    } catch (error) {
      const [current] = await Promise.allSettled([api.jumpServerBinding(project.id), refresh()]);
      if (current.status === "fulfilled") setBinding(current.value.binding);
      throw error;
    }
    await completeSync(updated, "同步完成");
  };
  const importCertificate = async (file: File) => {
    const message = "请选择 PEM 格式的 CA 或服务器公开证书。";
    if (file.size > 64000) throw new Error(message);
    const pem = (await file.text()).trim();
    if (!pem.startsWith("-----BEGIN CERTIFICATE-----") || pem.includes("PRIVATE KEY")) throw new Error(message);
    change({ca: pem});
  };
  const submit=async()=>{
    const credentials={...login,orgId:binding?.orgId ?? (login.orgId.trim() || defaultOrganizationId)};
    if(!preview) {
      const p=await api.previewJumpServer(project.id,credentials);
      setPreview(p);
      if(!host)setHost(new URL(login.origin).hostname.replace(/^\[|\]$/g,""));
      if(node && !p.nodes.some(n=>n.id===node))setNode("");
    } else {
      const b=await api.saveJumpServer(project.id,{...credentials,userId:preview.userId,nodeId:node||null,kokoHost:host.trim(),kokoPort:Number(port),expectedRevision:binding?.revision??0});
      setLogin(v=>({...v,secret:"",keyId:"",ca:""}));
      setPreview(null);
      setEdit(false);
      await completeSync(b, binding ? "已更新绑定并同步" : "已绑定并同步");
    }
  };
  const updateEndpoint = async () => {
    if (!binding) return;
    const updated = await api.updateJumpServerEndpoint(project.id,{kokoHost:host.trim(),kokoPort:Number(port),expectedRevision:binding.revision});
    setBinding(updated);
    setEditEndpoint(false);
    setFeedback("KoKo SSH 入口已更新");
  };
  const startEdit = (endpointOnly: boolean) => {
    if (!binding) return;
    setHost(binding.kokoHost);
    setPort(String(binding.kokoPort));
    setConfirmRemove(false);
    setError("");
    setFeedback("");
    if (endpointOnly) setEditEndpoint(true);
    else setEdit(true);
  };
  const endpointFields = <div className="jumpserver-endpoint">
    <label>KoKo SSH 地址<input required value={host} onChange={event=>setHost(event.target.value)}/></label>
    <label>SSH 端口<input required type="number" min={1} max={65535} value={port} onChange={event=>setPort(event.target.value)}/></label>
  </div>;
  return <Dialog title="JumpServer 资源来源" close={()=>{if(!busy)onClose();}}>
    <p className="jumpserver-project">{project.name}</p>
    {loading ? <p role="status">正在读取绑定…</p> : binding && !edit ? <>
      <dl><dt>绑定用户</dt><dd>{binding.username}</dd><dt>挂载目录</dt><dd>{binding.nodeName} · {binding.assetCount} 个资产</dd>
        <dt>同步状态</dt><dd>{binding.state==="denied"?"授权失效":binding.state==="offline"?"连接中断，显示上次目录":"自动同步已开启"}{binding.lastSync && " · "+new Date(binding.lastSync).toLocaleTimeString()}</dd>
        <dt>KoKo SSH</dt><dd>{binding.kokoHost} · {binding.kokoPort}</dd></dl>
      {editEndpoint ? <form onSubmit={event=>{event.preventDefault();void run("endpoint",updateEndpoint);}}>
        <fieldset disabled={busy}>
          {endpointFields}
          <div className="jumpserver-actions">
            <button type="button" className="button secondary" onClick={()=>{setEditEndpoint(false);setError("");}}>取消</button>
            <button type="submit" className="button primary">{operation==="endpoint" ? "正在保存…" : "保存 SSH 入口"}</button>
          </div>
        </fieldset>
      </form> : <div className="jumpserver-actions">
        <button className="button secondary" disabled={busy} aria-busy={syncing} onClick={()=>void run("sync",syncNow)}>{syncing ? "正在同步…" : "立即同步"}</button>
        <button className="button secondary" disabled={busy} onClick={()=>startEdit(false)}>编辑绑定</button>
        <button className="button secondary" disabled={busy} onClick={()=>startEdit(true)}>编辑 SSH 入口</button>
        <button className="button secondary" disabled={busy} onClick={()=>setConfirmRemove(v=>!v)}>解除绑定</button>
      </div>}
      {confirmRemove&&<div><p>解除后会移除本项目挂载目录，并断开此绑定的终端。</p><button className="button secondary" disabled={busy} onClick={()=>void run("remove",async()=>{await api.removeJumpServer(project.id,binding.id,binding.revision);await refresh();onClose();})}>确认解除</button></div>}
    </> : <form onSubmit={e=>{e.preventDefault();void run(preview?"bind":"verify",submit);}}><fieldset disabled={busy}>
      <label>JumpServer API 地址<input required type="url" placeholder="https://jumpserver.example.com" value={login.origin} onChange={e=>change({origin:e.target.value})}/></label>
      {login.origin.startsWith("http://")&&<label className="jumpserver-check"><input type="checkbox" checked={!!login.allowHttp} onChange={e=>change({allowHttp:e.target.checked})}/>允许此内网 HTTP 连接，登录令牌将明文传输</label>}
      <label>个人认证方式<AppSelect value={login.authMethod} onChange={e=>change({authMethod:e.target.value as JumpServerLogin["authMethod"],secret:""})}><option value="accessKey">Access Key</option><option value="bearer">Bearer Token</option></AppSelect></label>
      {login.authMethod==="accessKey"&&<label>Access Key ID<input required autoComplete="off" value={login.keyId??""} onChange={e=>change({keyId:e.target.value})}/></label>}
      <label>{login.authMethod==="accessKey"?"Access Key Secret":"个人 Token"}<input required type="password" autoComplete="off" value={login.secret} onChange={e=>change({secret:e.target.value})}/></label>
      <details><summary>{binding?"查看绑定组织":"切换组织"}</summary>
        <label>组织 UUID<input value={binding?.orgId ?? login.orgId} readOnly={!!binding} placeholder="留空使用默认组织" onChange={e=>change({orgId:e.target.value})}/></label>
      </details>
      {/^https:/i.test(login.origin.trim()) && <details>
        <summary>内部证书</summary>
        <textarea aria-label="CA 或服务器证书 PEM" placeholder="粘贴 CA 或服务器证书 PEM" value={login.ca ?? ""} rows={3} spellCheck={false} onChange={event => change({ca: event.target.value})}/>
        <input ref={certificateFile} hidden type="file" accept=".pem,.crt,.cer" aria-label="选择证书文件" onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void run("certificate", () => importCertificate(file));
        }}/>
        <button type="button" className="button secondary jumpserver-certificate-import" onClick={() => certificateFile.current?.click()}>
          <Glyph name="document" size={14}/>导入 PEM 文件
        </button>
      </details>}
      {preview&&<><p role="status">已验证用户 <strong>{preview.username}</strong></p>
        <label>挂载授权目录<AppSelect value={node} onChange={e=>setNode(e.target.value)}><option value="">我的全部授权资产</option>{preview.nodes.map(n=><option key={n.id} value={n.id}>{n.name}</option>)}</AppSelect></label>
        {endpointFields}</>}
      <div className="jumpserver-actions">{binding&&<button type="button" className="button secondary" onClick={()=>{setEdit(false);setLogin(v=>({...v,secret:""}));setPreview(null);}}>取消编辑</button>}
      <button className="button primary" disabled={busy} aria-busy={operation==="verify" || operation==="bind"}>
        {operation==="bind" ? "正在同步…" : operation==="verify" ? "正在验证…" : preview ? "绑定并同步" : "验证用户并读取目录"}
      </button></div>
    </fieldset></form>}
    <div role="status" aria-atomic="true">
      {feedback ? <p className="settings-test test-ok jumpserver-sync-success">{feedback}</p>
        : syncing && <span className="visually-hidden">正在同步 JumpServer 资源</span>}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </Dialog>;
}

export function JumpServerAccounts({resource,refresh,onClose}:{resource:Resource;refresh:()=>Promise<unknown>;onClose:()=>void}) {
  const [choices,setChoices]=useState<{id:string;name:string;alias:string}[]>([]),[choice,setChoice]=useState("");
  const [busy,setBusy]=useState(true),[error,setError]=useState("");
  useEffect(()=>{let active=true;void api.jumpServerAccounts(resource.id).then(({accounts})=>{
    if(!active)return;setChoices(accounts);setChoice(accounts.find(a=>a.id===resource.jumpServer?.accountId)?.id ?? (accounts.length===1?accounts[0].id:""));
  }).catch(e=>active&&setError(readableError(e))).finally(()=>active&&setBusy(false));return ()=>{active=false;};},[resource.id,resource.jumpServer?.accountId]);
  return <Dialog title="JumpServer 登录账号" close={onClose}><p>{resource.name}</p>
    <label>授权账号<AppSelect disabled={busy} value={choice} onChange={e=>setChoice(e.target.value)}><option value="">{busy?"读取中…":choices.length?"选择账号":"没有获准的 SSH 账号"}</option>{choices.map(a=><option key={a.id} value={a.id}>{a.name} · {a.alias}</option>)}</AppSelect></label>
    <div className="jumpserver-actions"><button className="button primary" disabled={!choice||busy} onClick={async()=>{setBusy(true);try{await api.chooseJumpServerAccount(resource.id,choice);await refresh();onClose();}catch(e){setError(readableError(e));}finally{setBusy(false);}}}>使用此账号</button></div>
    {error&&<p className="form-error" role="alert">{error}</p>}</Dialog>;
}
