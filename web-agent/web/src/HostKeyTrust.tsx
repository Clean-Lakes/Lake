import { useEffect, useState } from "react";
import type { SSHHostKeyTrust } from "../../shared/contracts";
import { api, readableError } from "./api";

export function HostKeyTrust({ session, prompt, disabled, refresh }: {
  session: string; prompt: SSHHostKeyTrust; disabled: boolean; refresh: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setError(""); }, [prompt.id]);
  const peer = `${prompt.host.includes(":") ? `[${prompt.host}]` : prompt.host}:${prompt.port}`;
  const decide = async (accept: boolean) => {
    setBusy(true); setError("");
    try {
      await api.hostKeyDecision(session, { id: prompt.id, accept, fingerprint: prompt.fingerprint });
      await refresh();
    } catch (e) { setError(readableError(e)); }
    finally { setBusy(false); }
  };
  return <div className="modal-scrim"><section className="modal host-key-modal" role="dialog" aria-modal="true" aria-labelledby="host-key-title">
    <h2 id="host-key-title">{prompt.changed ? "服务器指纹已变化" : "确认 SSH 服务器指纹"}</h2>
    <p className="modal-description">{prompt.changed ? "当前指纹与已保存的记录不同，请核对服务器身份后再确认。" : "首次连接此服务器，请与服务器管理员提供的指纹核对。"}</p>
    <dl className="host-key-facts"><div><dt>服务器</dt><dd>{peer}</dd></div><div><dt>密钥算法</dt><dd>{prompt.algorithm}</dd></div><div><dt>当前指纹</dt><dd><code>{prompt.fingerprint}</code></dd></div></dl>
    {!!prompt.previousFingerprints.length && <div className="host-key-previous"><span>之前保存的指纹</span>{prompt.previousFingerprints.map(value => <code key={value}>{value}</code>)}</div>}
    <p className="host-key-scope">确认后保存在 Lake 全局，所有项目和会话连接此服务器时都会复用。</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="button secondary" type="button" disabled={busy || disabled} onClick={() => void decide(false)}>取消连接</button><button className="button primary" type="button" disabled={busy || disabled} onClick={() => void decide(true)}>{busy ? "处理中…" : prompt.changed ? "信任新指纹并连接" : "信任并连接"}</button></div>
  </section></div>;
}
