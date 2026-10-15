import {AppSelect} from "./AppSelect";
import { useEffect, useRef, useState } from "react";
import type { SSHConnectionInput, SSHConnection } from "../../shared/contracts";

export const emptySSH = (): SSHConnectionInput => ({host: "", port: 22, username: "", authMethod: "key", identityFile: "", password: "", passphrase: ""});

export function SSHResourceFields({value, onChange, disabled, existing}: {value: SSHConnectionInput; onChange: (value: SSHConnectionInput) => void; disabled: boolean; existing?: SSHConnection}) {
  const storedPassword = existing?.authMethod === "password" && value.authMethod === "password" && !!existing.credentialRef;
  const storedKey = value.authMethod === "key" && existing?.authMethod !== "password" && !!existing?.identityFile && value.identityFile === existing.identityFile && !value.privateKey;
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const readVersion = useRef(0);
  const latestValue = useRef(value);
  latestValue.current = value;
  useEffect(() => () => { readVersion.current++; }, []);
  const set = (patch: Partial<SSHConnectionInput>) => onChange({...value, ...patch});
  const chooseKey = async (input: HTMLInputElement) => {
    const version = ++readVersion.current;
    const file = input.files?.[0];
    setError("");
    set({privateKey: undefined, identityFile: undefined});
    if (!file) { set({privateKey: undefined, identityFile: existing?.identityFile}); setReading(false); input.setCustomValidity(""); return; }
    if (!file.size || file.size > 1024 * 1024) {
      const message = "请选择非空的私钥文件，大小不超过 1 MB";
      setReading(false); setError(message); input.setCustomValidity(message); return;
    }
    setReading(true);
    input.setCustomValidity("正在读取私钥文件，请稍候");
    try {
      const privateKey = await file.text();
      if (version !== readVersion.current) return;
      if (!/^-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----\r?$/m.test(privateKey) || privateKey.includes("\0")) {
        throw new Error("请选择 SSH 私钥文件，而非公钥或其他文件");
      }
      onChange({...latestValue.current, privateKey, identityFile: undefined});
      input.setCustomValidity("");
    } catch {
      if (version !== readVersion.current) return;
      const message = "无法读取有效的 SSH 私钥，请重新选择私钥文件";
      setError(message); input.setCustomValidity(message);
    } finally {
      if (version === readVersion.current) setReading(false);
    }
  };
  return <fieldset disabled={disabled} className="ssh-credential-fields">
    <label className="field-label">主机地址<input required maxLength={253} value={value.host} onChange={e => set({host: e.target.value})}/></label>
    <label className="field-label">SSH 端口<input required type="number" min={1} max={65535} value={value.port} onChange={e => set({port: Number(e.target.value)})}/></label>
    <label className="field-label">登录用户<input required maxLength={64} value={value.username} autoComplete="off" onChange={e => set({username: e.target.value})}/></label>
    <label className="field-label">Shell<AppSelect value={value.shell ?? "sh"} onChange={e => set({shell: e.target.value as SSHConnectionInput["shell"]})}>{["sh","bash","zsh","fish"].map(shell => <option key={shell} value={shell}>{shell}</option>)}</AppSelect></label>
    <label className="field-label">登录方式<AppSelect value={value.authMethod ?? "key"} onChange={e => { readVersion.current++; setReading(false); setError(""); const keep = e.target.value === (existing?.authMethod ?? "key"); set({authMethod: e.target.value as "key" | "password", password: "", passphrase: "", privateKey: undefined, identityFile: keep ? existing?.identityFile : undefined, credentialRef: keep ? existing?.credentialRef : undefined}); }}><option value="key">SSH 密钥</option><option value="password">登录密码</option></AppSelect></label>
    {value.authMethod === "password" ? <label className="field-label">登录密码<input type="password" required={!storedPassword} placeholder={storedPassword ? "留空保留已保存的密码" : undefined} maxLength={4096} autoComplete="new-password" value={value.password ?? ""} onChange={e => set({password: e.target.value})}/></label> : <>
      <label className="field-label">私钥文件<input className="ssh-key-file-input" type="file" required={!storedKey} aria-describedby="ssh-key-upload-note" onChange={e => void chooseKey(e.currentTarget)}/></label>
      {storedKey && <p className="settings-note">已有私钥已保存。不选择新文件即可保留，上传新文件会替换私钥。</p>}
      {reading && <p className="settings-note" role="status">正在读取私钥文件…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <label className="field-label">密钥口令（可选）<input type="password" maxLength={4096} autoComplete="new-password" placeholder={storedKey && existing?.credentialRef ? "留空保留已保存的密钥口令" : "加密私钥的解锁口令"} value={value.passphrase ?? ""} onChange={e => set({passphrase: e.target.value})}/></label>
    </>}
    <p id="ssh-key-upload-note" className="settings-note">{existing ? (value.authMethod === "password" ? (storedPassword ? "密码留空保留当前凭据，填写新密码会替换。" : "更换为密码登录时，请填写新的登录密码。") : (storedKey ? "不选择新文件会保留当前私钥；密钥口令留空也会保留已有口令。" : "请选择本地私钥文件（最大 1 MB）；加密私钥可填写解锁口令。")) : value.authMethod === "password" ? "密码保存在 Lake 私有凭据目录，页面只保留引用；目标主机须已在 ~/.ssh/known_hosts 中受信任。" : "选择本地私钥文件（最大 1 MB）。创建资源时上传并保存到 Lake 私有凭据目录，私钥内容不会显示在页面。加密私钥可填写解锁口令。"}</p>
  </fieldset>;
}
