import {Glyph} from './Icons';
import {AppSelect} from "./AppSelect";
import {useEffect, useRef, useState, type FormEvent} from "react";
import type {Resource, SSHConnectionInput} from "../../shared/contracts";
import {api, readableError} from "./api";
import {SSHResourceFields, emptySSH} from "./SSHResourceFields";

export function TerminalConfigEdit({resource, connected, onClose, onSaved}: {
  resource: Resource; connected: boolean; onClose: () => void; onSaved: (resource: Resource) => void;
}) {
  const [name, setName] = useState(resource.name);
  const [ssh, setSSH] = useState<SSHConnectionInput>(() => ({...emptySSH(), host: resource.ssh?.host ?? "", port: resource.ssh?.port ?? 22, username: resource.ssh?.username ?? "", shell: resource.ssh?.shell ?? "bash", authMethod: resource.ssh?.authMethod ?? "key", identityFile: resource.ssh?.identityFile, credentialRef: resource.ssh?.credentialRef}));
  const [shell, setShell] = useState(String(resource.settings?.shell ?? "bash"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus(); input.current?.select();
    return () => { if (previous?.isConnected && previous !== document.body) previous.focus(); else document.getElementById(`resource-trigger-${resource.id}`)?.focus(); };
  }, [resource.id]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || !connected || !name.trim()) return;
    setBusy(true); setError("");
    try {
      const old = resource.ssh;
      const sshChanged = ssh.host !== old?.host || ssh.port !== (old?.port ?? 22) || ssh.username !== old?.username || ssh.shell !== (old?.shell ?? "bash") || ssh.authMethod !== (old?.authMethod ?? "key") || !!ssh.privateKey || !!ssh.password || !!ssh.passphrase;
      const saved = await api.editTerminalResource(resource.id, {name: name.trim(), ...(resource.kind === "ssh" ? (sshChanged ? {ssh} : {}) : shell !== (resource.settings?.shell ?? "bash") ? {settings: {shell}} : {})});
      onSaved(saved); onClose();
    } catch (error) { setError(readableError(error)); }
    finally {setBusy(false);}
  }
  return <div className="modal-scrim" onMouseDown={event => {if (event.target === event.currentTarget && !busy) onClose();}}>
    <section className="modal terminal-config-dialog" role="dialog" aria-modal="true" aria-labelledby="terminal-config-title" onKeyDown={event => {if (event.key === "Escape" && !busy) {event.stopPropagation(); onClose();}if (event.key === "Tab") {
      const fields = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)")].filter(element => !element.closest("fieldset:disabled"));
      const first = fields[0], last = fields.at(-1);
      if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
      if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
    }}}>
      <div className="modal-header"><span className="modal-icon"><Glyph name="terminal" size={20}/></span><button type="button" className="icon-button" aria-label="关闭终端配置编辑" disabled={busy} onClick={onClose}><Glyph name="close" size={14}/></button></div>
      <h2 id="terminal-config-title">编辑终端配置</h2><p className="modal-description">{resource.kind === "ssh" ? "修改 SSH 连接与登录配置。已有密码和私钥不会回显，留空保留原凭据。" : "修改本机资源名称和默认 Shell。"}修改连接配置前请先关闭在线终端。</p>
      <form onSubmit={event => void save(event)}>
        <label className="field-label">资源名称<input ref={input} required maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)}/></label>
        {resource.kind === "ssh" ? <SSHResourceFields value={ssh} existing={resource.ssh} disabled={busy} onChange={setSSH}/> : <label className="field-label">默认 Shell<AppSelect value={shell} disabled={busy} onChange={event => setShell(event.target.value)}>{["sh","bash","zsh","fish"].map(value => <option key={value} value={value}>{value}</option>)}</AppSelect></label>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={busy || !connected || !name.trim()}>{busy ? "正在保存…" : "保存配置"}</button></div>
      </form>
    </section>
  </div>;
}
